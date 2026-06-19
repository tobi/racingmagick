/**
 * video-laps — extract per-lap stats from PURELY a video file.
 *
 * For AiM SmartyCam .MOV onboards (embedded GPS), this reads lat/lon, detects
 * lap crossings, and streams a table of: lap time, distance, average speed,
 * and the lat/lon bounding box — no telemetry/.pds needed.
 *
 * Usage:
 *   pnpm exec tsx scripts/video-laps.ts <video> [--sf <lat> <lon>] [--csv]
 *
 * Output is streamed: metadata first, then one row per lap as it is computed.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import { extractVideoTelemetry } from '../src/video-extract';
import { haversine } from '../src/gps';

// ── args ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const csv = argv.includes('--csv');
const dump = argv.includes('--dump');
let sfLat: number | undefined, sfLon: number | undefined;
const sfIdx = argv.indexOf('--sf');
if (sfIdx >= 0) { sfLat = parseFloat(argv[sfIdx + 1]!); sfLon = parseFloat(argv[sfIdx + 2]!); }
const videoPath = argv.find((a) => !a.startsWith('--') && a !== String(sfLat) && a !== String(sfLon));
if (!videoPath) { console.error('usage: video-laps <video> [--sf <lat> <lon>] [--csv]'); process.exit(1); }

const out = (s: string) => process.stdout.write(s + '\n');

// ── helpers ──────────────────────────────────────────────────────────
function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '—';
  const m = Math.floor(sec / 60);
  const r = sec - m * 60;
  return `${m}:${r.toFixed(3).padStart(6, '0')}`;
}

/** Read the AiM aim_meta_data XML block from the moov atom, if present. */
function readAimMeta(path: string): Record<string, string> {
  const meta: Record<string, string> = {};
  try {
    const data = readFileSync(path);
    const i = data.indexOf(Buffer.from('<aim_meta_data'));
    if (i < 0) return meta;
    const j = data.indexOf(Buffer.from('</aim_meta_data>'), i);
    const xml = data.subarray(i, j + 16).toString('latin1');
    const re = /<p n="([^"]+)">([^<]*)<\/p>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) meta[m[1]!] = m[2]!;
  } catch { /* ignore */ }
  return meta;
}

type GpsSamples = ReturnType<typeof extractVideoTelemetry>['gps'];

const median = (arr: number[]): number => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1]!;
};
const percentile = (arr: number[], p: number): number => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};

/**
 * Estimate a car/track-agnostic plausible top speed (km/h) from the data itself,
 * so the system isn't tuned to any class. We take per-move GPS speeds, median-
 * filter (kills single-fix spikes), then a high percentile + margin. Clamped to
 * a broad sane range so empty/odd inputs don't misbehave.
 */
function estimatePlausibleVmaxKmh(samples: GpsSamples): number {
  if (samples.length < 20) return 360;
  // Average speed over a ~2s window from displacement (not per-fix derivative):
  // GPS jitter (~metres) is negligible against real travel (~100m+), so this is
  // robust to noise. Top speed ≈ 75th percentile of these window-speeds + ~25%
  // (most of a lap is spent below top speed; the upper quartile + margin lands
  // near the real maximum regardless of car class).
  const dtTarget = 2.0;
  const sp: number[] = [];
  let j = 0;
  for (let i = 0; i < samples.length; i++) {
    while (j < samples.length && samples[j]!.videoTime - samples[i]!.videoTime < dtTarget) j++;
    if (j >= samples.length) break;
    const dt = samples[j]!.videoTime - samples[i]!.videoTime;
    if (dt <= 0) continue;
    sp.push(haversine(samples[i]!.lat, samples[i]!.lon, samples[j]!.lat, samples[j]!.lon) / dt * 3.6);
  }
  if (sp.length < 10) return 360;
  return Math.max(60, Math.min(520, percentile(sp, 0.75) * 1.25));
}

type Pt = { t: number; lat: number; lon: number };

/** Windowed median filter over a numeric array. */
function medianFilter(arr: number[], win: number): number[] {
  const h = win >> 1;
  return arr.map((_, i) => median(arr.slice(Math.max(0, i - h), Math.min(arr.length, i + h + 1))));
}

/**
 * Clean polyline for geometry: dedupe by position change, median-filter the
 * coordinates (removes jitter), then a greedy speed gate (drops teleport fixes).
 * No pit/standing samples are discarded — only physically-impossible jumps.
 */
function buildCleanTrack(samples: GpsSamples, vmaxKmh: number): Pt[] {
  const mv: Pt[] = [];
  let la = NaN, lo = NaN;
  for (const s of samples) { if (s.lat === la && s.lon === lo) continue; mv.push({ t: s.videoTime, lat: s.lat, lon: s.lon }); la = s.lat; lo = s.lon; }
  if (mv.length < 3) return mv;
  const fLat = medianFilter(mv.map((p) => p.lat), 5), fLon = medianFilter(mv.map((p) => p.lon), 5);
  const out: Pt[] = [];
  for (let i = 0; i < mv.length; i++) {
    const p: Pt = { t: mv[i]!.t, lat: fLat[i]!, lon: fLon[i]! };
    if (out.length === 0) { out.push(p); continue; }
    const last = out[out.length - 1]!; const dt = p.t - last.t;
    const kmh = dt > 0 ? haversine(last.lat, last.lon, p.lat, p.lon) / dt * 3.6 : Infinity;
    if (kmh <= vmaxKmh) out.push(p);
  }
  return out;
}

/**
 * If segment P→Q crosses segment L0→L1, return the parameter t∈[0,1] along P→Q
 * of the intersection, else null. Planar (metres) inputs as [x,y].
 */
function segCrossParam(P: number[], Q: number[], L0: number[], L1: number[]): number | null {
  const r = [Q[0]! - P[0]!, Q[1]! - P[1]!], s = [L1[0]! - L0[0]!, L1[1]! - L0[1]!];
  const denom = r[0]! * s[1]! - r[1]! * s[0]!;
  if (Math.abs(denom) < 1e-9) return null;
  const qp = [L0[0]! - P[0]!, L0[1]! - P[1]!];
  const t = (qp[0]! * s[1]! - qp[1]! * s[0]!) / denom;
  const u = (qp[0]! * r[1]! - qp[1]! * r[0]!) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** Track scale from the GPS bounding-box diagonal — a lower bound on lap length. */
function estimateTrackDiagonalM(samples: GpsSamples): number {
  let mnLa = Infinity, mxLa = -Infinity, mnLo = Infinity, mxLo = -Infinity;
  for (const s of samples) { mnLa = Math.min(mnLa, s.lat); mxLa = Math.max(mxLa, s.lat); mnLo = Math.min(mnLo, s.lon); mxLo = Math.max(mxLo, s.lon); }
  if (!Number.isFinite(mnLa)) return 1000;
  return haversine(mnLa, mnLo, mxLa, mxLo);
}

/**
 * Drop GPS outliers: samples implying an implausible speed (data-derived) between
 * consecutive fixes are multipath glitches. Uses the embedded GPS clock when present.
 */
function filterOutliers(samples: GpsSamples, vmaxKmh: number): GpsSamples {
  if (samples.length < 3) return samples;
  const kept = [samples[0]!];
  for (let i = 1; i < samples.length; i++) {
    const a = kept[kept.length - 1]!, b = samples[i]!;
    const dtMs = (b.gpsTowMs ?? b.videoTime * 1000) - (a.gpsTowMs ?? a.videoTime * 1000);
    const dt = dtMs > 0 ? dtMs / 1000 : 0.25;
    const kmh = haversine(a.lat, a.lon, b.lat, b.lon) / dt * 3.6;
    if (kmh <= vmaxKmh) kept.push(b);
  }
  return kept;
}

// ── extract ──────────────────────────────────────────────────────────
const tel = extractVideoTelemetry(videoPath);
const aim = readAimMeta(videoPath);

// ── --dump: every raw sample with a physical-plausibility confidence ──
if (dump) {
  const raw = tel.gps;
  const fps = tel.metadata.fps || 25;
  // Data-derived plausible speed ceiling (works for karts → F1, not just LMP2).
  const vmaxKmh = estimatePlausibleVmaxKmh(raw);
  const vmaxMs = vmaxKmh / 3.6;
  const vSoft = 0.4 * vmaxMs;
  const bearing = (la1: number, lo1: number, la2: number, lo2: number): number => {
    const p = Math.PI / 180;
    const y = Math.sin((lo2 - lo1) * p) * Math.cos(la2 * p);
    const x = Math.cos(la1 * p) * Math.sin(la2 * p) - Math.sin(la1 * p) * Math.cos(la2 * p) * Math.cos((lo2 - lo1) * p);
    return (Math.atan2(y, x) / p + 360) % 360;
  };
  // sub-score: 1 inside [lo,hi], decays to 0 over `soft` beyond each edge.
  const band = (v: number, lo: number, hi: number, soft: number): number => {
    if (v >= lo && v <= hi) return 1;
    const d = v < lo ? lo - v : v - hi;
    return Math.max(0, 1 - d / soft);
  };
  // ---- Pass 1: per-sample kinematics + confidence ----
  // Position and the tow clock update on different frames, so we dedupe by
  // *position change* and measure intervals in videoTime. Held frames inherit
  // the previous fix's kinematics; only genuine moves are physics-scored.
  const n = raw.length;
  const conf = new Float64Array(n), spd = new Float64Array(n), acc = new Float64Array(n);
  const hdg = new Float64Array(n).fill(NaN), trn = new Float64Array(n), lg = new Float64Array(n);
  const flag: string[] = new Array(n).fill('hold');
  let prevSpeed = 0, prevHeading = NaN, lastLat = NaN, lastLon = NaN, lastTime = NaN;
  let cS = 0, cH = NaN, cT = 0, cLG = 0, cA = 0, cC = 1, cF = 'start';
  for (let i = 0; i < n; i++) {
    const s = raw[i]!;
    const moved = !(s.lat === lastLat && s.lon === lastLon);
    if (i === 0) { cC = 1; cF = 'start'; }
    else if (!moved) { cF = 'hold'; cA = 0; cT = 0; }
    else {
      const dt = (s.videoTime - lastTime) || 0.2;
      const v = haversine(lastLat, lastLon, s.lat, s.lon) / dt;
      const accel = (v - prevSpeed) / dt;
      const heading = bearing(lastLat, lastLon, s.lat, s.lon);
      let turn = 0, latG = 0;
      if (Number.isFinite(prevHeading)) {
        let dh = Math.abs(heading - prevHeading); if (dh > 180) dh = 360 - dh;
        turn = dh / dt; latG = (v * (turn * Math.PI / 180)) / 9.81;
      }
      const vScore = band(v, 0, vmaxMs, vSoft), aScore = band(accel, -65, 20, 25); // accel/brake g limits are universal
      const hScore = v < 8 ? 1 : band(latG, 0, 6, 4); // lateral g cap, only matters at speed
      const backtrack = v > 20 && turn * dt > 120;
      const fl: string[] = [];
      if (vScore < 0.95) fl.push('teleport');
      if (aScore < 0.95) fl.push('accel');
      if (hScore < 0.95) fl.push('lateral');
      if (backtrack) fl.push('backtrack');
      cS = v; cA = accel; cH = heading; cT = turn; cLG = latG;
      cC = vScore * aScore * hScore * (backtrack ? 0.1 : 1); cF = fl.join('|');
      prevSpeed = v; prevHeading = heading;
    }
    conf[i] = cC; spd[i] = cS; acc[i] = cA; hdg[i] = cH; trn[i] = cT; lg[i] = cLG; flag[i] = cF;
    if (moved) { lastLat = s.lat; lastLon = s.lon; lastTime = s.videoTime; }
  }

  // ---- Pass 2: robust smoothing via trusted-anchor interpolation (look-ahead) ----
  // 1) Anchors = moved fixes with confidence >= TRUST (teleports have conf~0 and
  //    are dropped outright). 2) Rebuild every frame by linear time-interpolation
  //    between the surrounding anchors. 3) Light centered moving-average to remove
  //    residual steps. This guarantees the smoothed track never teleports.
  const TRUST = 0.4;
  const anchT: number[] = [], anchLat: number[] = [], anchLon: number[] = [];
  for (let i = 1; i < n; i++) {
    const moved = raw[i]!.lat !== raw[i - 1]!.lat || raw[i]!.lon !== raw[i - 1]!.lon;
    if (moved && conf[i]! >= TRUST) { anchT.push(raw[i]!.videoTime); anchLat.push(raw[i]!.lat); anchLon.push(raw[i]!.lon); }
  }
  if (anchT.length < 2) { anchT.length = 0; for (let i = 0; i < n; i++) { anchT.push(raw[i]!.videoTime); anchLat.push(raw[i]!.lat); anchLon.push(raw[i]!.lon); } }
  // Median-filter the anchor sequence (window 5) to remove isolated spike anchors
  // that slipped past the confidence gate (e.g. the "return" fix after a teleport).
  const med = (arr: number[], win: number): number[] => {
    const out = new Array(arr.length); const h = win >> 1;
    for (let i = 0; i < arr.length; i++) {
      const w = arr.slice(Math.max(0, i - h), Math.min(arr.length, i + h + 1)).sort((x, y) => x - y);
      out[i] = w[w.length >> 1];
    }
    return out;
  };
  const mLat = med(anchLat, 5), mLon = med(anchLon, 5);
  // Greedy speed gate: keep an anchor only if reachable from the last kept one
  // under MAX_KMH. This bounds the interpolated track's speed and removes the
  // recurring close-in-time/far-in-position spike pairs median can't catch.
  const MAX_KMH = vmaxKmh;
  const gT: number[] = [], gLat: number[] = [], gLon: number[] = [];
  for (let i = 0; i < anchT.length; i++) {
    if (gT.length === 0) { gT.push(anchT[i]!); gLat.push(mLat[i]!); gLon.push(mLon[i]!); continue; }
    const dt = anchT[i]! - gT[gT.length - 1]!;
    const kmh = dt > 0 ? haversine(gLat[gLat.length - 1]!, gLon[gLon.length - 1]!, mLat[i]!, mLon[i]!) / dt * 3.6 : Infinity;
    if (kmh <= MAX_KMH) { gT.push(anchT[i]!); gLat.push(mLat[i]!); gLon.push(mLon[i]!); }
  }
  anchT.length = 0; anchLat.length = 0; anchLon.length = 0;
  for (let i = 0; i < gT.length; i++) { anchT.push(gT[i]!); anchLat.push(gLat[i]!); anchLon.push(gLon[i]!); }
  const interp = new Float64Array(n), interpLon = new Float64Array(n);
  let a = 0;
  for (let i = 0; i < n; i++) {
    const t = raw[i]!.videoTime;
    while (a < anchT.length - 2 && anchT[a + 1]! < t) a++;
    const t0 = anchT[a]!, t1 = anchT[a + 1]!;
    const f = t1 > t0 ? Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) : 0;
    interp[i] = anchLat[a]! + f * (anchLat[a + 1]! - anchLat[a]!);
    interpLon[i] = anchLon[a]! + f * (anchLon[a + 1]! - anchLon[a]!);
  }
  // light centered moving average (~0.6s)
  const latS = new Float64Array(n), lonS = new Float64Array(n);
  const H = 1;
  for (let i = 0; i < n; i++) {
    let sl = 0, so = 0, c = 0;
    for (let k = Math.max(0, i - H); k <= Math.min(n - 1, i + H); k++) { sl += interp[k]!; so += interpLon[k]!; c++; }
    latS[i] = sl / c; lonS[i] = so / c;
  }

  // ---- output ----
  process.stdout.write('idx,videoTime,frame,gpsTowMs,lat,lon,lat_s,lon_s,speed_kmh,accel_ms2,heading_deg,turn_dps,lat_g,confidence,flags\n');
  for (let i = 0; i < n; i++) {
    const s = raw[i]!; const tow = s.gpsTowMs ?? NaN;
    process.stdout.write(
      `${i},${s.videoTime.toFixed(3)},${Math.round(s.videoTime * fps)},${Number.isFinite(tow) ? tow : ''},` +
      `${s.lat.toFixed(7)},${s.lon.toFixed(7)},${latS[i]!.toFixed(7)},${lonS[i]!.toFixed(7)},` +
      `${(spd[i]! * 3.6).toFixed(1)},${acc[i]!.toFixed(2)},${Number.isFinite(hdg[i]!) ? hdg[i]!.toFixed(1) : ''},` +
      `${trn[i]!.toFixed(1)},${lg[i]!.toFixed(2)},${conf[i]!.toFixed(3)},${flag[i]}\n`);
  }
  process.exit(0);
}

const vmaxKmh = estimatePlausibleVmaxKmh(tel.gps);
const trackDiagM = estimateTrackDiagonalM(tel.gps);
const gps = filterOutliers(tel.gps, vmaxKmh);

// ── metadata block ───────────────────────────────────────────────────
out('# video-laps');
out(`file:            ${basename(videoPath)}`);
out(`duration:        ${tel.metadata.duration.toFixed(1)} s   fps: ${tel.metadata.fps.toFixed(2)}`);
out(`creation_time:   ${tel.metadata.creationTimeUnix ? new Date(tel.metadata.creationTimeUnix * 1000).toISOString() : '—'}`);
out(`gps source:      ${tel.gpsSource}`);
out(`gps samples:     ${gps.length}  (${(gps.length / (tel.metadata.duration || 1)).toFixed(2)} Hz)`);
if (gps.length) {
  const lat = gps.map((g) => g.lat), lon = gps.map((g) => g.lon);
  out(`bounds:          lat ${Math.min(...lat).toFixed(6)}..${Math.max(...lat).toFixed(6)}  lon ${Math.min(...lon).toFixed(6)}..${Math.max(...lon).toFixed(6)}`);
  if (gps[0]!.gpsTowMs !== undefined) out(`gps tow start:   ${gps[0]!.gpsTowMs} ms (GPS time-of-week)`);
}
if (Object.keys(aim).length) {
  out('aim_meta_data:');
  for (const [k, v] of Object.entries(aim)) out(`  ${k.padEnd(16)} ${v}`);
}
out('');

if (gps.length < 30) { out('Not enough GPS to detect laps.'); process.exit(0); }

// ── reconstruct the start/finish line, then detect crossings ─────────
// Work on a clean polyline so the S/F anchor & crossings ignore teleport
// outliers. We keep ALL samples (incl. pit/standing) — the first crossing just
// becomes lap 1's start. A crossing is a true geometric line intersection in
// the forward direction, so it can't be missed at high speed (unlike a
// proximity threshold). Override the auto line with --sf <lat> <lon>.
// Build the clean polyline from RAW gps: buildCleanTrack does its own robust
// videoTime-based dedupe/median/speed-gate. (The tow-clock filterOutliers used
// for the sample-count display drops too much due to the tow/position phase
// offset, which would fragment the track.)
const clean = buildCleanTrack(tel.gps, vmaxKmh);
const fps = tel.metadata.fps || 25;

// clean-track cumulative distance + per-step speed (km/h)
const cCum = new Float64Array(clean.length);
const cSpd = new Float64Array(clean.length);
for (let i = 1; i < clean.length; i++) {
  const d = haversine(clean[i - 1]!.lat, clean[i - 1]!.lon, clean[i]!.lat, clean[i]!.lon);
  cCum[i] = cCum[i - 1]! + d;
  const dt = (clean[i]!.t - clean[i - 1]!.t) || 0.2;
  cSpd[i] = d / dt * 3.6;
}
const cSpdMed = medianFilter(Array.from(cSpd), 9);
const interpAt = (arr: Float64Array, t: number): number => {
  if (clean.length === 0) return 0;
  if (t <= clean[0]!.t) return arr[0]!;
  if (t >= clean[clean.length - 1]!.t) return arr[clean.length - 1]!;
  let lo = 0, hi = clean.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; (clean[mid]!.t < t ? lo = mid : hi = mid); }
  const f = (t - clean[lo]!.t) / (clean[hi]!.t - clean[lo]!.t || 1);
  return arr[lo]! + f * (arr[hi]! - arr[lo]!);
};
const distAt = (t: number) => interpAt(cCum, t);

// local equirectangular projection (metres)
const lat0 = clean.reduce((s, p) => s + p.lat, 0) / Math.max(1, clean.length);
const mLat = 110540, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
const px = (p: Pt): number[] => [p.lon * mLon, p.lat * mLat];

// choose the S/F anchor index on the clean track
let aIdx = -1;
if (sfLat !== undefined) {
  let bd = Infinity;
  for (let i = 0; i < clean.length; i++) { const d = haversine(clean[i]!.lat, clean[i]!.lon, sfLat, sfLon!); if (d < bd) { bd = d; aIdx = i; } }
} else {
  // fastest point on the *clean* track: real top speed → a straight → stable
  // heading and crossed exactly once per lap. (No teleports remain to fool it.)
  let bs = -1;
  for (let i = 2; i < clean.length - 2; i++) if (cSpdMed[i]! > bs) { bs = cSpdMed[i]!; aIdx = i; }
}
if (aIdx < 1) aIdx = Math.floor(clean.length / 2);

// build the S/F line: perpendicular to travel at the anchor, half-width W
const A0 = px(clean[Math.max(0, aIdx - 1)]!), A1 = px(clean[Math.min(clean.length - 1, aIdx + 1)]!);
const dirx = A1[0]! - A0[0]!, diry = A1[1]! - A0[1]!;
const dl = Math.hypot(dirx, diry) || 1; const ux = dirx / dl, uy = diry / dl; // travel unit
const nx = -uy, ny = ux;                                                       // perpendicular
const W = Math.max(40, Math.min(200, 0.03 * trackDiagM));
const C = px(clean[aIdx]!);
const L0 = [C[0]! + nx * W, C[1]! + ny * W], L1 = [C[0]! - nx * W, C[1]! - ny * W];

// detect forward crossings, debounced by a minimum lap distance
const minLapDist = Math.max(300, Math.min(15000, 0.5 * trackDiagM));
const crossings: number[] = [];
let lastCrossCum = -Infinity;
for (let i = 0; i < clean.length - 1; i++) {
  const P = px(clean[i]!), Q = px(clean[i + 1]!);
  if ((Q[0]! - P[0]!) * ux + (Q[1]! - P[1]!) * uy <= 0) continue; // wrong direction
  const f = segCrossParam(P, Q, L0, L1);
  if (f === null) continue;
  const cumHere = cCum[i]! + f * (cCum[i + 1]! - cCum[i]!);
  if (cumHere - lastCrossCum < minLapDist) continue;
  crossings.push(clean[i]!.t + f * (clean[i + 1]!.t - clean[i]!.t));
  lastCrossCum = cumHere;
}
out(`S/F line:        @ ${clean[aIdx]!.lat.toFixed(5)},${clean[aIdx]!.lon.toFixed(5)} (reconstructed, ±${W.toFixed(0)}m, ${sfLat !== undefined ? 'user' : 'auto'})`);
out(`crossings:       ${crossings.length}  → ${Math.max(0, crossings.length - 1)} full laps`);
out('');

const spdAtMax = (t0: number, t1: number): number => {
  let mx = 0;
  for (let k = 0; k < clean.length; k++) if (clean[k]!.t >= t0 && clean[k]!.t <= t1 && cSpdMed[k]! > mx) mx = cSpdMed[k]!;
  return mx;
};

// ── stream the table ─────────────────────────────────────────────────
const header = csv
  ? 'lap,start_s,start_frame,end_frame,lap_time_s,distance_m,avg_speed_kmh,max_speed_kmh'
  : `${'lap'.padStart(3)}  ${'start'.padStart(8)}  ${'startF'.padStart(8)}  ${'endF'.padStart(8)}  ${'lap time'.padStart(9)}  ${'dist(m)'.padStart(8)}  ${'avg km/h'.padStart(8)}  ${'max km/h'.padStart(8)}`;
out(header);
if (!csv) out('-'.repeat(header.length));

for (let i = 0; i < crossings.length - 1; i++) {
  const t0 = crossings[i]!, t1 = crossings[i + 1]!;
  const lapTime = t1 - t0;
  const dist = distAt(t1) - distAt(t0);
  const avg = dist / lapTime * 3.6;
  const maxSpd = spdAtMax(t0, t1);
  const lapNo = i + 1;
  const startFrame = Math.round(t0 * fps);
  const endFrame = Math.round(t1 * fps);
  if (csv) out(`${lapNo},${t0.toFixed(2)},${startFrame},${endFrame},${lapTime.toFixed(3)},${dist.toFixed(1)},${avg.toFixed(1)},${maxSpd.toFixed(1)}`);
  else out(`${String(lapNo).padStart(3)}  ${t0.toFixed(1).padStart(8)}  ${String(startFrame).padStart(8)}  ${String(endFrame).padStart(8)}  ${fmtTime(lapTime).padStart(9)}  ${dist.toFixed(0).padStart(8)}  ${avg.toFixed(1).padStart(8)}  ${maxSpd.toFixed(1).padStart(8)}`);
}
