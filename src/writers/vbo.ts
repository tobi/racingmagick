/**
 * VBO file writer — export any Session as a VBOX .vbo text file.
 *
 * This enables converting MoTeC (.ld) and PDS (.pds) telemetry into
 * the universal VBO format that VBOX tools can read.
 */

import { writeFileSync, existsSync, realpathSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, basename, extname } from 'path';
import type { Session } from '../session';

/**
 * Write a Session to a .vbo file.
 *
 * @param session - The parsed session to export
 * @param directory - Output directory
 * @param filename - Output filename (without extension)
 * @returns Path to the written .vbo file
 */
export function saveVbo(session: Session, directory: string, filename: string): string {
  const outPath = join(directory, filename + '.vbo');
  const content = buildVboContent(session);
  writeFileSync(outPath, content, 'utf-8');
  return outPath;
}

export interface SaveVideoOptions {
  /** Re-encode video with h264+aac for browser compatibility and seekability. Default: true */
  reencode?: boolean;
  /** CRF quality (0=lossless, 18=visually lossless, 23=default). Default: 18 */
  crf?: number;
  /** Keyframe interval in frames. Default: 30 (1s at 30fps) */
  gopSize?: number;
}

/**
 * Write a Session to a .vbo file and re-encode associated video files
 * to browser-friendly h264 mp4 with proper keyframes.
 *
 * @param session - The parsed session to export
 * @param directory - Output directory
 * @param filename - Output filename (without extension)
 * @param options - Video encoding options
 * @returns { vboPath, videoPaths[] }
 */
export function saveVboAndVideo(
  session: Session,
  directory: string,
  filename: string,
  options: SaveVideoOptions = {},
): { vboPath: string; videoPaths: string[] } {
  const vboPath = saveVbo(session, directory, filename);
  const videoPaths: string[] = [];
  const { reencode = true, crf = 18, gopSize = 30 } = options;

  if (session.video && session.video.files.length > 0) {
    for (let i = 0; i < session.video.files.length; i++) {
      const vf = session.video.files[i]!;

      // Resolve symlinks (NAS mounts)
      let srcPath = vf.path;
      try { srcPath = realpathSync(vf.path); } catch { /* use original */ }
      if (!existsSync(srcPath)) continue;

      const videoOutPath = join(directory, `${filename}_${String(i + 1).padStart(4, '0')}.mp4`);

      if (reencode && findFfmpeg()) {
        try {
          reencodeVideo(srcPath, videoOutPath, crf, gopSize);
          videoPaths.push(videoOutPath);
        } catch (err: any) {
          console.error(`  ffmpeg failed: ${err.message?.slice(0, 80)}`);
        }
      } else {
        // Fallback: stream copy (no re-encode)
        const { createReadStream, createWriteStream } = require('fs');
        const rd = createReadStream(srcPath);
        const wr = createWriteStream(videoOutPath);
        rd.pipe(wr);
        videoPaths.push(videoOutPath);
      }
    }
  }

  return { vboPath, videoPaths };
}

// ── Video re-encoding ────────────────────────────────────────────────

let _ffmpegPath: string | null | undefined;

function findFfmpeg(): string | null {
  if (_ffmpegPath !== undefined) return _ffmpegPath;
  for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (existsSync(p)) { _ffmpegPath = p; return p; }
  }
  _ffmpegPath = null;
  return null;
}

/**
 * Re-encode a video to h264+aac mp4 with:
 * - CRF 18 (visually lossless, ~40-60% smaller than intra-only source)
 * - Keyframe every 1s (seekable in browsers)
 * - faststart (progressive download)
 * - Same resolution, no rescaling
 */
function reencodeVideo(src: string, dst: string, crf: number, gopSize: number): void {
  const ffmpeg = findFfmpeg()!;
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'warning',
    '-i', src,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', String(crf),
    '-g', String(gopSize),
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-y', dst,
  ], { timeout: 600_000 }); // 10 min timeout
}

// ── VBO content builder ──────────────────────────────────────────────

function buildVboContent(session: Session): string {
  const lines: string[] = [];
  const matrix = session.matrix;
  const sourceHz = matrix.sampleRate;

  // Circuit Tools 3 supports max 25Hz. Downsample if needed.
  const MAX_VBO_HZ = 25;
  const step = sourceHz > MAX_VBO_HZ ? Math.round(sourceHz / MAX_VBO_HZ) : 1;
  const hz = sourceHz / step;
  const n = Math.ceil(matrix.sampleCount / step);

  // File created line
  const d = session.date;
  const dateStr = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  const timeStr = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  lines.push(`File created on ${dateStr} @ ${timeStr}`);
  lines.push('');

  // Determine which channels to write
  // Standard VBO columns: sats time lat long velocity heading height vert-vel sampleperiod solution_type
  // Plus any ECU channels we have
  const vboColumns = buildColumnMap(session);

  // [header] section — full channel names (spaces allowed, one per line)
  lines.push('[header]');
  for (const col of vboColumns) {
    lines.push(col.headerName);
  }
  lines.push('');

  // [channel units] section — starts from avisynctime (index 11), covering
  // avisynctime and all ECU channels. The first 11 columns (sats, time, lat,
  // lon, velocity, heading, height, vert-vel, sampleperiod, solution_type,
  // avifileindex) do NOT get entries.
  lines.push('[channel units]');
  const CORE_COUNT = 11;
  for (let i = CORE_COUNT; i < vboColumns.length; i++) {
    lines.push(vboColumns[i]!.unit || '(null)');
  }
  lines.push('');

  // [comments] section
  lines.push('[comments]');
  lines.push(`(c) racingmagick — converted from ${session.format}`);
  if (session.driver) lines.push(`Driver: ${session.driver}`);
  if (session.vehicle) lines.push(`Vehicle: ${session.vehicle}`);
  if (session.track) lines.push(`Track: ${session.track}`);
  lines.push('');

  // [circuit details] section
  if (session.track || session.circuit) {
    lines.push('[circuit details]');
    if (session.circuit?.country) lines.push(`country ${session.circuit.country}`);
    if (session.track) lines.push(`circuit ${session.track}`);
    lines.push('');
  }

  // [session data] section
  const timed = session.timedLaps();
  if (timed.length > 0) {
    const fastest = session.fastestLap();
    lines.push('[session data]');
    lines.push(`laps ${timed.length}`);
    if (fastest) {
      const secs = fastest.lapTime / 1000;
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      lines.push(`fastest ${m}m ${s.toFixed(2)}s`);
    }
    lines.push('');
  }

  // [column names] section — short names, NO spaces (space-delimited line)
  lines.push('[column names]');
  lines.push(vboColumns.map(c => c.columnName).join(' '));
  lines.push('');

  // [laptiming] section
  if (session.circuit?.timingLines.length) {
    lines.push('[laptiming]');
    for (const tl of session.circuit.timingLines) {
      const type = tl.type === 'start' ? 'Start' : 'Split';
      lines.push(`${type} +${tl.start.lon.toFixed(7)} +${tl.start.lat.toFixed(7)} +${tl.end.lon.toFixed(7)} +${tl.end.lat.toFixed(7)} \xac ${tl.name}`);
    }
    lines.push('');
  }

  // [data] section
  lines.push('[data]');

  const timeRow = matrix.channels[0]; // time
  const baseTime = timeRow[0]!;

  for (let i = 0; i < n; i++) {
    const si = i * step; // source index (accounts for downsampling)
    if (si >= matrix.sampleCount) break;
    const values: string[] = [];
    for (const col of vboColumns) {
      values.push(col.format(si, matrix, session, hz, baseTime));
    }
    lines.push(values.join(' '));
  }

  return lines.join('\n') + '\n';
}

// ── Column definitions ───────────────────────────────────────────────

interface VboColumn {
  /** Full name for [header] section (can have spaces) */
  headerName: string;
  /** Short name for [column names] section (no spaces) */
  columnName: string;
  unit: string;
  format: (i: number, matrix: any, session: Session, hz: number, baseTime: number) => string;
}

function buildColumnMap(session: Session): VboColumn[] {
  const matrix = session.matrix;
  const cols: VboColumn[] = [];

  // satellites — plain integer, no padding
  cols.push({
    headerName: 'satellites', columnName: 'sats',
    unit: '(null)',
    format: (i) => {
      const row = matrix.row('gpsSatellites');
      return row ? String(Math.round(row[i]!)).padStart(3, '0') : '000';
    },
  });

  // time — VBO uses HHMMSS.mmm format
  cols.push({
    headerName: 'time', columnName: 'time',
    unit: '',
    format: (i, m, s, hz, baseTime) => {
      const sessionSecs = matrix.channels[0][i]!;
      // Convert session time to absolute time of day
      const absSeconds = session.date.getHours() * 3600 + session.date.getMinutes() * 60 +
        session.date.getSeconds() + sessionSecs;
      const h = Math.floor(absSeconds / 3600) % 24;
      const min = Math.floor((absSeconds % 3600) / 60);
      const sec = absSeconds % 60;
      return `${pad2(h)}${pad2(min)}${sec.toFixed(3).padStart(6, '0')}`;
    },
  });

  // latitude — VBOX minutes format (decimal degrees × 60)
  cols.push({ headerName: 'latitude', columnName: 'lat', unit: '', format: (i) => {
    const row = matrix.row('gpsLat');
    if (!row || row[i] === 0) return '+0.00000000';
    return formatVboxMinutes(row[i]!);
  }});

  // longitude — VBOX minutes format
  cols.push({ headerName: 'longitude', columnName: 'long', unit: '', format: (i) => {
    const row = matrix.row('gpsLon');
    if (!row || row[i] === 0) return '+0.00000000';
    return formatVboxMinutes(row[i]!);
  }});

  // velocity (km/h) — fixed-width: 057.506
  cols.push({ headerName: 'velocity kmh', columnName: 'velocity', unit: 'kmh', format: (i) => {
    const v = matrix.channels[3][i]!;
    return v.toFixed(3).padStart(7, '0');
  }});

  // heading
  cols.push({ headerName: 'heading', columnName: 'heading', unit: '', format: (i) => {
    const row = matrix.row('heading');
    return row ? row[i]!.toFixed(3).padStart(7, '0') : '000.000';
  }});

  // height
  cols.push({ headerName: 'height', columnName: 'height', unit: '', format: (i) => {
    const row = matrix.row('gpsAlt');
    return row ? formatSigned(row[i]!, 2) : '+00000.00';
  }});

  // vertical velocity
  cols.push({ headerName: 'vertical velocity m/s', columnName: 'vert-vel', unit: 'm/s', format: () => '+0000.00' });

  // sample period
  cols.push({ headerName: 'sampleperiod', columnName: 'Tsample', unit: '', format: (_, __, ___, hz) => (1 / hz).toFixed(4).padStart(5, '0') });

  // solution type
  cols.push({ headerName: 'solution type', columnName: 'solution_type', unit: '', format: (i) => {
    const row = matrix.row('gpsFix');
    return row ? pad2(Math.round(row[i]!)) : '00';
  }});

  // avifileindex — video file index (VBOX standard column)
  cols.push({ headerName: 'avifileindex', columnName: 'avifileindex', unit: '', format: () => '00001' });

  // avisynctime — video sync time (VBOX standard column)
  cols.push({ headerName: 'avisynctime', columnName: 'avitime', unit: 's', format: (i) => {
    const sessionSecs = matrix.channels[0][i]!;
    return sessionSecs.toFixed(4).padStart(10, '0');
  }});

  // ECU channels with physical value ranges for clamping.
  // Every value gets clamped to its valid range — no garbage reaches the output.
  const ecuChannels: Array<{ canonical: string; headerName: string; columnName: string; unit: string; min: number; max: number }> = [
    { canonical: 'speed', headerName: 'Vehicle_Speed', columnName: 'Vehicle_Speed', unit: 'kmh', min: 0, max: 400 },
    { canonical: 'rpm', headerName: 'Engine_Speed', columnName: 'Engine_Speed', unit: 'RPM', min: 0, max: 20000 },
    { canonical: 'throttle', headerName: 'Throttle_Pedal', columnName: 'Throttle_Pedal', unit: '%', min: 0, max: 100 },  // after *100
    { canonical: 'brakePressure', headerName: 'Brake_Pressure_Front', columnName: 'Brake_Pressure_Front', unit: 'bar', min: 0, max: 200 },
    { canonical: 'steering', headerName: 'Steering_Angle', columnName: 'Steering_Angle', unit: '(null)', min: -900, max: 900 },
    { canonical: 'gear', headerName: 'Gear', columnName: 'Gear', unit: '(null)', min: -1, max: 9 },
    { canonical: 'gLong', headerName: 'ComboAcc', columnName: 'ComboAcc', unit: 'G', min: -8, max: 8 },
    { canonical: 'gLat', headerName: 'Combo_G', columnName: 'Combo_G', unit: 'G', min: -8, max: 8 },
    { canonical: 'wheelSpeedFL', headerName: 'whlspeed_FL', columnName: 'whlspeed_FL', unit: 'kmh', min: 0, max: 400 },
    { canonical: 'wheelSpeedFR', headerName: 'whlspeed_FR', columnName: 'whlspeed_FR', unit: 'kmh', min: 0, max: 400 },
    { canonical: 'wheelSpeedRL', headerName: 'whlspeed_RL', columnName: 'whlspeed_RL', unit: 'kmh', min: 0, max: 400 },
    { canonical: 'wheelSpeedRR', headerName: 'whlspeed_RR', columnName: 'whlspeed_RR', unit: 'kmh', min: 0, max: 400 },
    { canonical: 'tirePressureFL', headerName: 'Tire_Pressure_FL', columnName: 'Tire_Pressure_FL', unit: 'bar', min: 0, max: 5 },
    { canonical: 'tirePressureFR', headerName: 'Tire_Pressure_FR', columnName: 'Tire_Pressure_FR', unit: 'bar', min: 0, max: 5 },
    { canonical: 'tirePressureRL', headerName: 'Tire_Pressure_RL', columnName: 'Tire_Pressure_RL', unit: 'bar', min: 0, max: 5 },
    { canonical: 'tirePressureRR', headerName: 'Tire_Pressure_RR', columnName: 'Tire_Pressure_RR', unit: 'bar', min: 0, max: 5 },
    { canonical: 'tireTempFL', headerName: 'Tire_Temp_FL', columnName: 'Tire_Temp_FL', unit: 'C', min: 0, max: 200 },
    { canonical: 'tireTempFR', headerName: 'Tire_Temp_FR', columnName: 'Tire_Temp_FR', unit: 'C', min: 0, max: 200 },
    { canonical: 'tireTempRL', headerName: 'Tire_Temp_RL', columnName: 'Tire_Temp_RL', unit: 'C', min: 0, max: 200 },
    { canonical: 'tireTempRR', headerName: 'Tire_Temp_RR', columnName: 'Tire_Temp_RR', unit: 'C', min: 0, max: 200 },
  ];

  // Synthesized Lap_Number — increment at each lap boundary so the VBO
  // parser can detect transitions when re-parsing.
  if (session.laps.length > 1) {
    const lapNums = new Float64Array(matrix.sampleCount);
    let currentNum = 1;
    // Fill first lap
    lapNums.fill(currentNum, 0, session.laps[0]!.endIdx);
    for (let l = 1; l < session.laps.length; l++) {
      currentNum++;
      const lap = session.laps[l]!;
      lapNums.fill(currentNum, lap.startIdx, Math.min(lap.endIdx, matrix.sampleCount));
    }
    cols.push({
      headerName: 'Lap_Number', columnName: 'Lap_Number',
      unit: '',
      format: (i) => String(Math.round(lapNums[i]!)),
    });
  }

  for (const ecu of ecuChannels) {
    const row = matrix.row(ecu.canonical);
    if (!row) continue;

    // Skip channels that are all zeros (not recorded)
    let nonZero = 0;
    const checkLen = Math.min(row.length, 10000);
    for (let j = 0; j < checkLen; j++) {
      if (isFinite(row[j]!) && row[j] !== 0) nonZero++;
    }
    if (nonZero === 0) continue;

    // Capture ecu in closure
    const ch = ecu;
    cols.push({
      headerName: ch.headerName, columnName: ch.columnName,
      unit: ch.unit,
      format: (i) => {
        let v = row[i]!;
        if (!isFinite(v)) v = 0;
        if (ch.canonical === 'throttle') v *= 100;
        // Clamp to physical range — no garbage reaches the output
        v = Math.max(ch.min, Math.min(ch.max, v));
        return formatSci(v);
      },
    });
  }

  return cols;
}

// ── Formatting helpers ───────────────────────────────────────────────

function pad2(n: number): string {
  return String(Math.floor(n)).padStart(2, '0');
}

/** Format as VBO scientific notation: +1.234567E+02 (always 2-digit exponent) */
function formatSci(v: number): string {
  if (!isFinite(v)) return '+0.000000E+00';
  const sign = v >= 0 ? '+' : '';
  // toExponential gives e+1 but VBOX needs E+01
  const s = v.toExponential(6).replace('e', 'E');
  // Ensure 2-digit exponent: E+1 → E+01, E-1 → E-01
  return sign + s.replace(/E([+-])(\d)$/, 'E$1' + '0$2');
}

/** Format as signed fixed: +00123.45 */
function formatSigned(v: number, decimals: number): string {
  const sign = v >= 0 ? '+' : '';
  return sign + Math.abs(v).toFixed(decimals).padStart(8, '0');
}

/**
 * Convert decimal degrees to VBOX minutes format (degrees × 60).
 * VBOX stores coordinates as total minutes with sign.
 */
function formatVboxMinutes(decimalDeg: number): string {
  const sign = decimalDeg >= 0 ? '+' : '-';
  const totalMinutes = Math.abs(decimalDeg) * 60;
  return `${sign}${totalMinutes.toFixed(8)}`;
}
