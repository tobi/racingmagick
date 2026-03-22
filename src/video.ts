/**
 * Video attachment, discovery, and synchronization.
 *
 * Each format has a different philosophy:
 * - VBO: [AVI] section lists filenames, avifileindex/avitime per sample → frame-perfect
 * - PDS: auto-discover Pi camera video by filename convention, sync via FIA_GpsTimeUTC
 * - MoTeC: discover by filename stem, sync via UTC or geometry fallback
 *
 * After sync, every telemetry sample maps to a video time and optional frame index.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename, extname } from 'path';

// ── Types ────────────────────────────────────────────────────────────

export type VideoSyncMethod =
  | 'vbox-native'        // VBO avifileindex/avitime — frame-perfect
  | 'utc-absolute'       // FIA_GpsTimeUTC ↔ video creation time
  | 'gps-sf-crossing'    // GPS S/F line crossing in both telemetry and video
  | 'geometry'           // duration-based fallback (low confidence)
  | 'manual';            // user-provided two-point alignment

export interface VideoFile {
  /** Absolute path to the video file. */
  readonly path: string;
  /** Filename only. */
  readonly filename: string;
  /** Duration in seconds (from metadata, 0 if unknown). */
  readonly duration: number;
  /** Video file index (VBO: from [AVI] section, 1-based). */
  readonly index: number;
}

export interface VideoSync {
  /** How the sync was established. */
  readonly method: VideoSyncMethod;
  /** Confidence 0.0–1.0. */
  readonly confidence: number;
  /** Offset: videoTime = sessionTime * rate + offset */
  readonly offset: number;
  /** Rate: accounts for clock drift (usually 1.0). */
  readonly rate: number;
  /** Convert session time (seconds) to video time (seconds). */
  videoTimeAt(sessionTime: number): number;
  /** Convert video time to session time. */
  sessionTimeAt(videoTime: number): number;
}

export interface VideoAttachment {
  /** Discovered video files. */
  readonly files: ReadonlyArray<VideoFile>;
  /** Sync parameters (null if no sync established). */
  readonly sync: VideoSync | null;
  /**
   * Per-sample video time mapping (seconds into video).
   * Null if no sync. Length = matrix.sampleCount.
   * NaN for samples outside the video's time range.
   */
  readonly videoTime: Float64Array | null;
  /**
   * Per-sample video file index (1-based, for multi-file VBO recordings).
   * Null if not available (PDS/MoTeC always have a single file).
   */
  readonly videoFileIndex: Uint8Array | null;
}

// ── Video sync implementation ────────────────────────────────────────

function createSync(method: VideoSyncMethod, offset: number, rate: number, confidence: number): VideoSync {
  return {
    method,
    confidence,
    offset,
    rate,
    videoTimeAt(sessionTime: number): number {
      return sessionTime * this.rate + this.offset;
    },
    sessionTimeAt(videoTime: number): number {
      return (videoTime - this.offset) / this.rate;
    },
  };
}

// ── Video file discovery ─────────────────────────────────────────────

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.m4v', '.webm']);

/**
 * Discover video files near a telemetry file.
 * Searches: same directory, parent directory, video/ and videos/ subfolders.
 */
export function discoverVideoFiles(telemetryPath: string): VideoFile[] {
  const dir = dirname(telemetryPath);
  const stem = basename(telemetryPath, extname(telemetryPath));
  const candidates: VideoFile[] = [];

  const searchDirs = [
    dir,
    dirname(dir),
    join(dir, 'video'),
    join(dir, 'videos'),
    join(dirname(dir), 'video'),
    join(dirname(dir), 'videos'),
  ];

  for (const searchDir of searchDirs) {
    if (!existsSync(searchDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(searchDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const ext = extname(entry).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(ext)) continue;

      const fullPath = join(searchDir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }

      const score = scoreFilenameMatch(stem, basename(entry, ext));
      if (score > 0) {
        candidates.push({
          path: fullPath,
          filename: entry,
          duration: 0, // would need ffprobe to fill this
          index: candidates.length + 1,
        });
      }
    }
  }

  // Prefer _keyframed.mp4 versions (browser-seekable)
  const keyframedCandidates: VideoFile[] = [];
  const regularCandidates: VideoFile[] = [];
  for (const c of candidates) {
    if (c.filename.includes('_keyframed')) keyframedCandidates.push(c);
    else regularCandidates.push(c);
  }

  // For each regular video, check if a keyframed version exists and prefer it
  const result: VideoFile[] = [...keyframedCandidates];
  for (const reg of regularCandidates) {
    const kfName = reg.filename.replace(/\.(mp4|mov|mkv|avi)$/i, '_keyframed.mp4');
    const alreadyHasKf = keyframedCandidates.some(k => k.filename === kfName);
    if (!alreadyHasKf) result.push(reg);
  }

  // Sort by match quality (best first)
  result.sort((a, b) => {
    const sa = scoreFilenameMatch(stem, basename(a.filename, extname(a.filename)));
    const sb = scoreFilenameMatch(stem, basename(b.filename, extname(b.filename)));
    return sb - sa;
  });

  return result;
}

// ── VBO-specific: parse [AVI] section and build native video mapping ─

export interface VboAviInfo {
  /** Base filename prefix from [AVI] section. */
  baseFilename: string;
  /** File extensions. */
  extensions: string[];
}

/**
 * Parse the [AVI] section from VBO file content.
 * Format:
 *   [AVI]
 *   <base_filename_>
 *   <ext1>
 *   <ext2>
 */
export function parseVboAviSection(content: string): VboAviInfo | null {
  const lines = content.split(/\r?\n/);
  const aviIdx = lines.findIndex(l => l.trim() === '[AVI]');
  if (aviIdx < 0) return null;

  const result: VboAviInfo = { baseFilename: '', extensions: [] };
  for (let i = aviIdx + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === '' || line.startsWith('[')) break;
    if (!result.baseFilename) {
      result.baseFilename = line;
    } else {
      result.extensions.push(line);
    }
  }

  return result.baseFilename ? result : null;
}

/**
 * Build per-sample video time/file index arrays from VBO avifileindex and avitime columns.
 */
export function buildVboVideoMapping(
  aviFileIndex: Float64Array,
  aviSyncTime: Float64Array,
  sampleCount: number,
): { videoTime: Float64Array; videoFileIndex: Uint8Array } {
  const videoTime = new Float64Array(sampleCount);
  const videoFileIndex = new Uint8Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    // aviSyncTime is in milliseconds
    videoTime[i] = (aviSyncTime[i] ?? 0) / 1000;
    videoFileIndex[i] = Math.max(1, Math.round(aviFileIndex[i] ?? 1));
  }

  return { videoTime, videoFileIndex };
}

// ── PDS/MoTeC: UTC-based sync ────────────────────────────────────────

export interface UtcSyncInput {
  /** Session start as Unix timestamp (seconds). From FIA_GpsTimeUTC or Global Time channel. */
  sessionStartUnix: number;
  /** Session duration in seconds. */
  sessionDuration: number;
  /** Video creation time as Unix timestamp (from file metadata). */
  videoCreationUnix: number;
  /** Video duration in seconds. */
  videoDuration: number;
}

/**
 * Attempt UTC-based auto-sync between telemetry and video.
 * Sweeps timezone offsets ±14h to find the best overlap.
 */
export function attemptUtcSync(input: UtcSyncInput): VideoSync | null {
  const { sessionStartUnix, sessionDuration, videoCreationUnix, videoDuration } = input;
  if (!sessionStartUnix || !videoCreationUnix || sessionDuration <= 0 || videoDuration <= 0) {
    return null;
  }

  let bestScore = -1;
  let bestOffset = 0;
  let bestShift = 0;

  for (let hourShift = -14; hourShift <= 14; hourShift++) {
    const shiftedVideoStart = videoCreationUnix + hourShift * 3600;
    // offset: how far into the video does sessionTime=0 occur
    const offset = sessionStartUnix - shiftedVideoStart;

    // Check overlap
    const videoEnd = videoDuration;
    const sessionEndInVideo = sessionDuration + offset;

    const overlapStart = Math.max(0, offset);
    const overlapEnd = Math.min(videoEnd, sessionEndInVideo);
    const overlap = Math.max(0, overlapEnd - overlapStart);

    const overlapRatio = overlap / Math.min(videoDuration, sessionDuration);
    const lapCoverage = overlap / sessionDuration;

    // Penalize large timezone shifts
    const shiftPenalty = Math.abs(hourShift) > 2 ? 0.05 * Math.abs(hourShift) : 0;

    const score = 0.7 * overlapRatio + 0.3 * lapCoverage - shiftPenalty;

    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
      bestShift = hourShift;
    }
  }

  if (bestScore <= 0.15) return null;

  return createSync('utc-absolute', bestOffset, 1.0, Math.min(1.0, bestScore));
}

// ── Geometry fallback sync ───────────────────────────────────────────

/**
 * Geometry-based fallback: try centering, start-align, end-align.
 */
export function attemptGeometrySync(sessionDuration: number, videoDuration: number): VideoSync | null {
  if (sessionDuration <= 0 || videoDuration <= 0) return null;

  // Try: center telemetry within video
  const centerOffset = (videoDuration - sessionDuration) / 2;
  // Try: telemetry starts 5s into video
  const startOffset = 5;
  // Try: telemetry ends 5s before video end
  const endOffset = videoDuration - sessionDuration - 5;

  // Pick the one with best overlap
  const candidates = [
    { offset: centerOffset, label: 'center' },
    { offset: startOffset, label: 'start' },
    { offset: endOffset, label: 'end' },
  ];

  let best = candidates[0]!;
  let bestOverlap = 0;

  for (const c of candidates) {
    const overlapStart = Math.max(0, c.offset);
    const overlapEnd = Math.min(videoDuration, sessionDuration + c.offset);
    const overlap = Math.max(0, overlapEnd - overlapStart) / sessionDuration;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = c;
    }
  }

  if (bestOverlap <= 0.15) return null;

  return createSync('geometry', best.offset, 1.0, Math.min(0.5, bestOverlap * 0.5));
}

// ── Build per-sample video time from sync ────────────────────────────

/**
 * Build a Float64Array of video timestamps for each telemetry sample.
 * NaN for samples that fall outside the video's range.
 */
export function buildVideoTimeFromSync(
  sessionTimeChannel: Float64Array,
  sync: VideoSync,
  videoDuration: number,
): Float64Array {
  const n = sessionTimeChannel.length;
  const videoTime = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const vt = sync.videoTimeAt(sessionTimeChannel[i]!);
    videoTime[i] = (vt >= 0 && vt <= videoDuration) ? vt : NaN;
  }

  return videoTime;
}

// ── Filename matching ────────────────────────────────────────────────

/**
 * Score how well two filenames match.
 * Tokenizes on common separators, normalizes, and counts matches.
 * Returns 0 for no match, higher = better.
 */
export function scoreFilenameMatch(telemetryStem: string, videoStem: string): number {
  const tokenize = (s: string) => {
    return s
      .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase split
      .split(/[_\-#.() ]+/)
      .map(t => t.toLowerCase())
      .filter(t => t.length > 0)
      .map(t => {
        // Normalize run numbers: Run001 → run1
        const runMatch = t.match(/^run0*(\d+)$/);
        if (runMatch) return `run${runMatch[1]}`;
        // Drop long numeric strings (timestamps)
        if (/^\d{8,}$/.test(t)) return '';
        return t;
      })
      .filter(t => t.length > 0);
  };

  const telTokens = tokenize(telemetryStem);
  const vidTokens = tokenize(videoStem);

  if (telTokens.length === 0 || vidTokens.length === 0) return 0;

  // Exact stem match = highest score
  if (telemetryStem.toLowerCase() === videoStem.toLowerCase()) return 100;

  // Token matching
  let score = 0;
  const vidSet = new Set(vidTokens);

  for (const tt of telTokens) {
    if (vidSet.has(tt)) {
      score += tt.length <= 3 ? 2 : 1;
    } else {
      // Substring match
      for (const vt of vidTokens) {
        if (vt.includes(tt) || tt.includes(vt)) {
          score += 0.5;
          break;
        }
      }
    }
  }

  return score < 3 ? 0 : score; // Reject weak matches
}

// ── Video re-encoding commands ────────────────────────────────────────

/**
 * Generate ffmpeg commands to re-encode videos with proper keyframes
 * for browser seek support. Output files get _keyframed.mp4 suffix.
 *
 * Uses libx264 with keyframe interval of 1s (GOP = fps), same resolution,
 * CRF 20 for good quality at potentially better compression than the
 * VBOX's original intra-only encoding.
 */
export function fixVideoCommands(videoFiles: ReadonlyArray<VideoFile>): string[] {
  return videoFiles.map(f => {
    const outPath = f.path.replace(/\.(mp4|mov|mkv|avi)$/i, '_keyframed.mp4');
    // -g sets keyframe interval (1 second = fps frames)
    // -movflags +faststart enables progressive download / seek
    // CRF 20 = visually lossless at ~60% of original intra-frame size
    return `ffmpeg -i "${f.path}" -c:v libx264 -preset medium -crf 20 -g 30 -c:a aac -movflags +faststart "${outPath}"`;
  });
}

// ── Build full video attachment for a session ────────────────────────

export interface BuildVideoAttachmentOptions {
  telemetryPath: string;
  format: 'motec' | 'pds' | 'vbo';
  sessionDuration: number;
  /** VBO-specific: parsed [AVI] section info. */
  vboAvi?: VboAviInfo | null;
  /** VBO-specific: avifileindex channel data. */
  vboAviFileIndex?: Float64Array;
  /** VBO-specific: avisynctime channel data. */
  vboAviSyncTime?: Float64Array;
  /** PDS/MoTeC: session start Unix timestamp (from FIA_GpsTimeUTC or Global Time). */
  sessionStartUnix?: number;
  /** Matrix sample count. */
  sampleCount: number;
  /** Session time channel (for building per-sample video time). */
  sessionTimeChannel: Float64Array;
}

export function buildVideoAttachment(opts: BuildVideoAttachmentOptions): VideoAttachment {
  // 1. Discover video files
  const files = discoverVideoFiles(opts.telemetryPath);

  if (files.length === 0) {
    return { files: [], sync: null, videoTime: null, videoFileIndex: null };
  }

  // 2. VBO native path — frame-perfect mapping
  if (opts.format === 'vbo' && opts.vboAviFileIndex && opts.vboAviSyncTime) {
    const { videoTime, videoFileIndex } = buildVboVideoMapping(
      opts.vboAviFileIndex,
      opts.vboAviSyncTime,
      opts.sampleCount,
    );

    const sync = createSync('vbox-native', 0, 1.0, 1.0);
    return { files, sync, videoTime, videoFileIndex };
  }

  // 3. UTC absolute sync (PDS with FIA_GpsTimeUTC, or MoTeC with global time)
  if (opts.sessionStartUnix && files.length > 0) {
    // TODO: read video creation time from file metadata (needs ffprobe or mp4 parser)
    // For now, attempt geometry fallback
  }

  // 4. Geometry fallback
  if (files.length > 0 && files[0]!.duration > 0) {
    const sync = attemptGeometrySync(opts.sessionDuration, files[0]!.duration);
    if (sync) {
      const videoTime = buildVideoTimeFromSync(opts.sessionTimeChannel, sync, files[0]!.duration);
      return { files, sync, videoTime, videoFileIndex: null };
    }
  }

  // 5. No sync possible — just return discovered files
  return { files, sync: null, videoTime: null, videoFileIndex: null };
}
