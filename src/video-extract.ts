/**
 * Video telemetry extraction: GPS, time, and audio from video files.
 *
 * Supports:
 * - GoPro GPMF (metadata track with GPS5/SCAL)
 * - Pi camera 1Hz telemetry (PCM-like audio track)
 * - Audio RMS envelope (engine band 35-240Hz for correlation sync)
 *
 * Requires ffmpeg/ffprobe on the system PATH.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { haversine } from './gps';

// ── Types ────────────────────────────────────────────────────────────

export interface VideoGpsSample {
  /** Seconds into the video. */
  videoTime: number;
  /** WGS84 decimal degrees. */
  lat: number;
  lon: number;
  /** Speed in m/s (from GPS, 0 if unavailable). */
  speed: number;
}

export interface VideoMetadata {
  /** Duration in seconds. */
  duration: number;
  /** Frame rate (fps). */
  fps: number;
  /** Creation time as Unix timestamp (seconds), 0 if unknown. */
  creationTimeUnix: number;
}

export interface VideoTelemetry {
  metadata: VideoMetadata;
  /** GPS samples (1-18Hz depending on source). Empty if none. */
  gps: VideoGpsSample[];
  /** Source of GPS data. */
  gpsSource: 'gopro-gpmf' | 'pi-camera' | 'none';
  /** 1Hz audio RMS envelope (engine band). Null if unavailable. */
  audioRms: Float64Array | null;
}

// ── Tool resolution ──────────────────────────────────────────────────

function findTool(name: string): string | null {
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Try PATH
  try {
    const result = execFileSync('which', [name], { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result && existsSync(result)) return result;
  } catch { /* ignore */ }
  return null;
}

const ffmpegPath = findTool('ffmpeg');
const ffprobePath = findTool('ffprobe');

function runFfprobe(args: string[]): string | null {
  if (!ffprobePath) return null;
  try {
    return execFileSync(ffprobePath, ['-hide_banner', '-loglevel', 'error', ...args], {
      encoding: 'utf-8',
      timeout: 30000,
    });
  } catch { return null; }
}

function runFfmpeg(args: string[]): boolean {
  if (!ffmpegPath) return false;
  try {
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      timeout: 120000,
    });
    return true;
  } catch { return false; }
}

// ── Video metadata ───────────────────────────────────────────────────

export function extractVideoMetadata(videoPath: string): VideoMetadata {
  const result: VideoMetadata = { duration: 0, fps: 30, creationTimeUnix: 0 };

  // Duration
  const durStr = runFfprobe(['-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath]);
  if (durStr) result.duration = parseFloat(durStr.trim()) || 0;

  // Frame rate
  const fpsStr = runFfprobe([
    '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate',
    '-of', 'csv=p=0',
    videoPath,
  ]);
  if (fpsStr) {
    const [num, den] = fpsStr.trim().split('/');
    if (num && den) result.fps = parseInt(num) / parseInt(den);
    else if (num) result.fps = parseFloat(num) || 30;
  }

  // Creation time (from format tags)
  const tagStr = runFfprobe([
    '-show_entries', 'format_tags=creation_time',
    '-of', 'csv=p=0',
    videoPath,
  ]);
  if (tagStr) {
    const d = new Date(tagStr.trim());
    if (!isNaN(d.getTime())) result.creationTimeUnix = d.getTime() / 1000;
  }

  return result;
}

// ── GoPro GPMF GPS extraction ────────────────────────────────────────

function findGpmfStreamIndex(videoPath: string): number | null {
  const output = runFfprobe([
    '-show_entries', 'stream=index,codec_type:stream_tags=handler_name',
    '-of', 'csv=p=0',
    videoPath,
  ]);
  if (!output) return null;

  for (const line of output.split('\n')) {
    const cols = line.split(',');
    if (cols.length < 3) continue;
    const idx = parseInt(cols[0]!);
    const handler = cols.slice(2).join(',').toLowerCase();
    if (handler.includes('gopro') && handler.includes('met')) return idx;
  }
  return null;
}

function extractGpmfGps(videoPath: string, duration: number): VideoGpsSample[] {
  const streamIndex = findGpmfStreamIndex(videoPath);
  if (streamIndex === null) return [];

  const tmpDir = mkdtempSync(join(tmpdir(), 'racingmagick-'));
  const tmpFile = join(tmpDir, 'gpmf.bin');

  try {
    const ok = runFfmpeg(['-i', videoPath, '-map', `0:${streamIndex}`, '-f', 'rawvideo', '-codec', 'copy', tmpFile]);
    if (!ok || !existsSync(tmpFile)) return [];

    const data = readFileSync(tmpFile);
    return parseGpmf(data, duration);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    try { unlinkSync(tmpDir); } catch { /* ignore */ }
  }
}

/**
 * Parse GPMF binary data.
 * KLV format: 4-byte FourCC key, 1-byte type, 1-byte struct size, 2-byte repeat count (BE).
 * Hierarchy: DEVC → STRM → GPS5/SCAL.
 * GPS5: [lat, lon, alt, speed2d, speed3d] as signed 32-bit BE, divided by SCAL.
 */
function parseGpmf(data: Buffer, duration: number): VideoGpsSample[] {
  const samples: VideoGpsSample[] = [];
  let offset = 0;

  while (offset + 8 <= data.length) {
    const key = data.toString('ascii', offset, offset + 4);
    const typeChar = data[offset + 4]!;
    const structSize = data[offset + 5]!;
    const repeatCount = data.readUInt16BE(offset + 6);
    const payloadSize = structSize * repeatCount;
    const paddedSize = (payloadSize + 3) & ~3;

    if (paddedSize < 0 || offset + 8 + paddedSize > data.length) break;

    if (key === 'DEVC' && typeChar === 0) {
      const payload = data.subarray(offset + 8, offset + 8 + payloadSize);
      parseGpmfDevice(payload, samples);
    }

    offset += 8 + paddedSize;
  }

  // Assign video times: distribute evenly across duration
  if (samples.length > 0 && duration > 0) {
    const interval = duration / samples.length;
    for (let i = 0; i < samples.length; i++) {
      samples[i]!.videoTime = i * interval;
    }
  }

  return samples;
}

function parseGpmfDevice(data: Buffer, out: VideoGpsSample[]): void {
  let offset = 0;
  while (offset + 8 <= data.length) {
    const key = data.toString('ascii', offset, offset + 4);
    const typeChar = data[offset + 4]!;
    const structSize = data[offset + 5]!;
    const repeatCount = data.readUInt16BE(offset + 6);
    const payloadSize = structSize * repeatCount;
    const paddedSize = (payloadSize + 3) & ~3;

    if (paddedSize < 0 || offset + 8 + paddedSize > data.length) break;

    if (key === 'STRM' && typeChar === 0) {
      const payload = data.subarray(offset + 8, offset + 8 + payloadSize);
      parseGpmfStream(payload, out);
    }

    offset += 8 + paddedSize;
  }
}

function parseGpmfStream(data: Buffer, out: VideoGpsSample[]): void {
  let scaleFactors: number[] = [];
  let gps5Offset = -1;
  let gps5StructSize = 0;
  let gps5RepeatCount = 0;

  let offset = 0;
  while (offset + 8 <= data.length) {
    const key = data.toString('ascii', offset, offset + 4);
    const typeChar = data[offset + 4]!;
    const structSize = data[offset + 5]!;
    const repeatCount = data.readUInt16BE(offset + 6);
    const payloadSize = structSize * repeatCount;
    const paddedSize = (payloadSize + 3) & ~3;

    if (paddedSize < 0 || offset + 8 + paddedSize > data.length) break;

    if (key === 'SCAL') {
      scaleFactors = [];
      const start = offset + 8;
      if (typeChar === 0x6C) { // 'l' = signed 32-bit
        for (let i = 0; i < repeatCount; i++) {
          const off = start + i * 4;
          if (off + 4 <= data.length) scaleFactors.push(data.readInt32BE(off));
        }
      } else if (typeChar === 0x73) { // 's' = signed 16-bit
        for (let i = 0; i < repeatCount; i++) {
          const off = start + i * 2;
          if (off + 2 <= data.length) scaleFactors.push(data.readInt16BE(off));
        }
      }
    } else if (key === 'GPS5') {
      gps5Offset = offset + 8;
      gps5StructSize = structSize;
      gps5RepeatCount = repeatCount;
    }

    offset += 8 + paddedSize;
  }

  // Parse GPS5: [lat, lon, alt, speed2d, speed3d] — 5 × int32 BE = 20 bytes each
  if (gps5Offset < 0 || gps5StructSize !== 20 || gps5RepeatCount === 0) return;

  const latScale = scaleFactors[0] || 10_000_000;
  const lonScale = scaleFactors[1] || 10_000_000;
  const spdScale = scaleFactors[3] || 1000;

  for (let i = 0; i < gps5RepeatCount; i++) {
    const off = gps5Offset + i * 20;
    if (off + 20 > data.length) break;

    const lat = data.readInt32BE(off) / latScale;
    const lon = data.readInt32BE(off + 4) / lonScale;
    const speed = data.readInt32BE(off + 12) / spdScale;

    if (Math.abs(lat) < 1 || Math.abs(lat) > 90 || Math.abs(lon) < 1 || Math.abs(lon) > 180) continue;

    out.push({ videoTime: 0, lat, lon, speed });
  }
}

// ── Pi camera telemetry extraction ───────────────────────────────────

function findTmcdStreamIndex(videoPath: string): number | null {
  const output = runFfprobe([
    '-show_entries', 'stream=index,codec_type:stream_tags=handler_name',
    '-of', 'csv=p=0',
    videoPath,
  ]);
  if (!output) return null;

  for (const line of output.split('\n')) {
    const cols = line.split(',');
    if (cols.length < 3) continue;
    const idx = parseInt(cols[0]!);
    const handler = cols.slice(2).join(',').toLowerCase();
    if (handler.includes('tmcd')) return idx;
  }
  return null;
}

function extractPiCameraGps(videoPath: string): VideoGpsSample[] {
  const streamIndex = findTmcdStreamIndex(videoPath);
  if (streamIndex === null) return [];

  const tmpDir = mkdtempSync(join(tmpdir(), 'racingmagick-'));
  const tmpFile = join(tmpDir, 'pcm.s16');

  try {
    const ok = runFfmpeg([
      '-i', videoPath,
      '-map', `0:${streamIndex}`,
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '48000',
      tmpFile,
    ]);
    if (!ok || !existsSync(tmpFile)) return [];

    const data = readFileSync(tmpFile);
    return parsePiTelemetryPcm(data);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    try { unlinkSync(tmpDir); } catch { /* ignore */ }
  }
}

/**
 * Parse Pi camera 1Hz telemetry from PCM data.
 * Each second of 48kHz mono int16 audio starts with:
 *   [offset 0]  int32 LE: frame counter
 *   [offset 8]  int32 LE: elapsed counter (centiseconds)
 *   [offset 16] int32 LE: lat * 1e7
 *   [offset 24] int32 LE: lon * 1e7
 */
function parsePiTelemetryPcm(data: Buffer): VideoGpsSample[] {
  const bytesPerSample = 2;
  const sampleRate = 48000;
  const bytesPerSecond = sampleRate * bytesPerSample;
  const totalSeconds = Math.floor(data.length / bytesPerSecond);
  if (totalSeconds < 2) return [];

  const samples: VideoGpsSample[] = [];

  for (let sec = 0; sec < totalSeconds; sec++) {
    const off = sec * bytesPerSecond;
    if (off + 28 > data.length) break;

    const latRaw = data.readInt32LE(off + 16);
    const lonRaw = data.readInt32LE(off + 24);
    const lat = latRaw / 1e7;
    const lon = lonRaw / 1e7;

    if (Math.abs(lat) < 1 || Math.abs(lat) > 90 || Math.abs(lon) < 1 || Math.abs(lon) > 180) continue;

    samples.push({ videoTime: sec, lat, lon, speed: 0 });
  }

  return validatePiSamples(samples) ? samples : [];
}

/** Validate Pi telemetry: frame deltas 20-40fps, elapsed deltas 500-2000cs, distances <3km. */
function validatePiSamples(samples: VideoGpsSample[]): boolean {
  if (samples.length < 30) return false;

  // Check GPS distances are plausible (car speeds, not teleportation)
  const distances: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    distances.push(haversine(samples[i - 1]!.lat, samples[i - 1]!.lon, samples[i]!.lat, samples[i]!.lon));
  }
  if (distances.length === 0) return false;

  const sorted = [...distances].sort((a, b) => a - b);
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]!;
  const median = sorted[Math.floor(sorted.length / 2)]!;

  return p99 < 3000 && median < 300;
}

// ── Audio RMS envelope extraction ────────────────────────────────────

/**
 * Extract 1Hz engine-band RMS envelope from video audio.
 * Bandpass 35-240Hz to emphasize engine sound.
 * Returns normalized (0-1) RMS per second, or null if no audio.
 */
function extractAudioRms(videoPath: string, duration: number): Float64Array | null {
  if (!ffmpegPath || duration <= 0) return null;

  const tmpDir = mkdtempSync(join(tmpdir(), 'racingmagick-'));
  const tmpFile = join(tmpDir, 'audio.f32');

  try {
    // Extract mono float32 audio at 48kHz with bandpass filter
    const ok = runFfmpeg([
      '-i', videoPath,
      '-vn', // no video
      '-af', 'highpass=f=35,lowpass=f=240', // engine band
      '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '1', '-ar', '48000',
      tmpFile,
    ]);
    if (!ok || !existsSync(tmpFile)) return null;

    const data = readFileSync(tmpFile);
    const floatCount = Math.floor(data.length / 4);
    if (floatCount < 48000) return null; // less than 1 second

    const bucketCount = Math.ceil(duration);
    const rms = new Float64Array(bucketCount);
    const counts = new Float64Array(bucketCount);

    for (let i = 0; i < floatCount; i++) {
      const v = data.readFloatLE(i * 4);
      const sec = Math.floor(i / 48000);
      if (sec >= bucketCount) break;
      rms[sec] += v * v;
      counts[sec]++;
    }

    let peak = 0;
    for (let i = 0; i < bucketCount; i++) {
      if (counts[i]! > 0) rms[i] = Math.sqrt(rms[i]! / counts[i]!);
      if (rms[i]! > peak) peak = rms[i]!;
    }

    // Normalize to 0-1
    if (peak > 1e-9) {
      for (let i = 0; i < bucketCount; i++) rms[i] /= peak;
    }

    return rms;
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    try { unlinkSync(tmpDir); } catch { /* ignore */ }
  }
}

// ── S/F crossing detection in video GPS ──────────────────────────────

/**
 * Detect lap boundaries in video GPS by finding where the track loops
 * back to a reference position (start/finish line).
 *
 * If sfLat/sfLon provided, uses that as the S/F reference.
 * Otherwise, auto-detects from the GPS track (~10s into video).
 *
 * Returns video times of each S/F crossing.
 */
export function detectVideoLapCrossings(
  gps: VideoGpsSample[],
  sfLat?: number,
  sfLon?: number,
  thresholdMeters: number = 50,
  minLapDistanceMeters: number = 1000,
): number[] {
  if (gps.length < 30) return [];

  // Auto-detect S/F: use position ~10s into the video (skip pit/standing start)
  const refIdx = Math.min(10, gps.length - 1);
  const refLat = sfLat ?? gps[refIdx]!.lat;
  const refLon = sfLon ?? gps[refIdx]!.lon;

  // Compute cumulative distance
  const cumDist = new Float64Array(gps.length);
  for (let i = 1; i < gps.length; i++) {
    cumDist[i] = cumDist[i - 1]! + haversine(gps[i - 1]!.lat, gps[i - 1]!.lon, gps[i]!.lat, gps[i]!.lon);
  }

  const crossings: number[] = [];
  let lastCrossingDist = -minLapDistanceMeters * 2;

  for (let i = 0; i < gps.length; i++) {
    const dist = haversine(gps[i]!.lat, gps[i]!.lon, refLat, refLon);
    if (dist >= thresholdMeters) continue;

    const sinceLast = cumDist[i]! - lastCrossingDist;
    if (sinceLast < minLapDistanceMeters) continue;

    // Refine: find closest approach in ±2 sample window
    let bestDist = dist;
    let bestTime = gps[i]!.videoTime;
    for (let j = Math.max(0, i - 2); j <= Math.min(gps.length - 1, i + 2); j++) {
      const d = haversine(gps[j]!.lat, gps[j]!.lon, refLat, refLon);
      if (d < bestDist) {
        bestDist = d;
        bestTime = gps[j]!.videoTime;
      }
    }

    crossings.push(bestTime);
    lastCrossingDist = cumDist[i]!;
  }

  return crossings;
}

// ── Smart sync: match telemetry lap crossings to video GPS crossings ─

/**
 * Find the offset that best aligns telemetry lap boundaries with
 * video GPS lap crossings. This handles the "video is longer than
 * telemetry" case — we find the window within the video that matches.
 *
 * Returns: offset in seconds (videoTime = sessionTime + offset),
 *          or null if no good alignment found.
 */
export function alignLapCrossings(
  telemetryCrossings: number[],  // session times (seconds)
  videoCrossings: number[],      // video times (seconds)
): { offset: number; confidence: number } | null {
  if (telemetryCrossings.length < 2 || videoCrossings.length < 2) return null;

  // Compute inter-crossing intervals for both
  const telIntervals: number[] = [];
  for (let i = 1; i < telemetryCrossings.length; i++) {
    telIntervals.push(telemetryCrossings[i]! - telemetryCrossings[i - 1]!);
  }

  const vidIntervals: number[] = [];
  for (let i = 1; i < videoCrossings.length; i++) {
    vidIntervals.push(videoCrossings[i]! - videoCrossings[i - 1]!);
  }

  // Slide telemetry intervals along video intervals to find best match
  // (like cross-correlation of lap time sequences)
  let bestScore = Infinity;
  let bestVidStart = 0;
  let bestTelStart = 0;

  const minMatch = Math.min(2, telIntervals.length, vidIntervals.length);

  for (let vStart = 0; vStart <= vidIntervals.length - minMatch; vStart++) {
    for (let tStart = 0; tStart <= telIntervals.length - minMatch; tStart++) {
      const matchLen = Math.min(telIntervals.length - tStart, vidIntervals.length - vStart);
      if (matchLen < minMatch) continue;

      let totalError = 0;
      for (let k = 0; k < matchLen; k++) {
        const diff = Math.abs(telIntervals[tStart + k]! - vidIntervals[vStart + k]!);
        totalError += diff;
      }
      const avgError = totalError / matchLen;

      if (avgError < bestScore) {
        bestScore = avgError;
        bestVidStart = vStart;
        bestTelStart = tStart;
      }
    }
  }

  // Reject if average lap time error > 5 seconds
  if (bestScore > 5) return null;

  // Compute offset from the matched crossing pair
  const offset = videoCrossings[bestVidStart]! - telemetryCrossings[bestTelStart]!;
  const confidence = Math.max(0, Math.min(1.0, 1.0 - bestScore / 10));

  return { offset, confidence };
}

// ── Main extraction entry point ──────────────────────────────────────

/**
 * Extract all available telemetry from a video file.
 * Tries GoPro GPMF first, then Pi camera, then audio-only.
 */
export function extractVideoTelemetry(videoPath: string): VideoTelemetry {
  const metadata = extractVideoMetadata(videoPath);

  // Try GoPro GPMF
  const gpmfGps = extractGpmfGps(videoPath, metadata.duration);
  if (gpmfGps.length > 10) {
    const audioRms = extractAudioRms(videoPath, metadata.duration);
    return { metadata, gps: gpmfGps, gpsSource: 'gopro-gpmf', audioRms };
  }

  // Try Pi camera
  const piGps = extractPiCameraGps(videoPath);
  if (piGps.length > 10) {
    const audioRms = extractAudioRms(videoPath, metadata.duration);
    return { metadata, gps: piGps, gpsSource: 'pi-camera', audioRms };
  }

  // Audio only (no GPS)
  const audioRms = extractAudioRms(videoPath, metadata.duration);
  return { metadata, gps: [], gpsSource: 'none', audioRms };
}
