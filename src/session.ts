import { createHash } from 'crypto';
import { ChannelMatrix, buildChannelMatrix } from './channel-matrix';
import type { ChannelMatrixBuilderInput } from './channel-matrix';
import { Lap } from './lap';
import { buildLaps, computeSectorTimes } from './lap-classification';
import { resolveAllChannels, resolveThrottleChannels, CHANNEL_PRIORITIES } from './channels';
import type { ChannelTransform } from './channels';
import { buildVideoAttachment } from './video';
import type { VideoAttachment } from './video';
import {
  integrateSpeed, filterGpsForArcLength, computeGpsArcLength,
  smoothGps, detectCoordinateSystem, convertCoordinates,
} from './gps';
import type {
  SessionData, SessionFormat, SessionWarning, ChannelAvailability,
  CircuitInfo, LapInfo, Stint, PositionSource, RawChannel,
} from './types';
import { ParseError, LapKind, CH_TIME, CH_DISTANCE, CH_TRACK_POSITION, CH_SPEED } from './types';
import { CUSTOM_CHANNEL_PREFIX, GPS_INVALID_FRACTION_THRESHOLD } from './constants';

// ── Pipeline stage types ──────────────────────────────────────────────

interface ResolvedChannels {
  resolved: Map<string, { rawIndex: number; transform: ChannelTransform | null }>;
  warnings: SessionWarning[];
}

// ── Pipeline stages (pure functions, individually testable) ───────────

/** Stage 1-3: Resolve raw channels to canonical names, validate required channels. */
function resolveAndValidateChannels(
  rawChannels: RawChannel[],
  format: string,
  fileURL: string,
  existingWarnings: SessionWarning[],
): ResolvedChannels {
  const warnings: SessionWarning[] = [];
  const resolved = resolveAllChannels(rawChannels);

  const tResult = resolveThrottleChannels(resolved);
  if (tResult.warning) {
    warnings.push({ code: 'throttle-fallback', message: tResult.warning });
  }

  if (!resolved.has('speed')) {
    throw new ParseError(`No speed channel found in ${fileURL}`, format, { fileURL });
  }
  if (!resolved.has('throttle')) {
    throw new ParseError(`No throttle channel found in ${fileURL}`, format, { fileURL });
  }

  return { resolved, warnings };
}

/** Stage 4: Build ChannelMatrix inputs from resolved channels + custom channels. */
function buildMatrixInputs(
  rawChannels: RawChannel[],
  resolved: Map<string, { rawIndex: number; transform: ChannelTransform | null }>,
): ChannelMatrixBuilderInput[] {
  const builderInputs: ChannelMatrixBuilderInput[] = [];
  const usedIndices = new Set<number>();

  for (const [canonical, { rawIndex, transform }] of resolved) {
    const raw = rawChannels[rawIndex]!;
    usedIndices.add(rawIndex);
    let samples = raw.samples;

    if (transform) {
      const normalized = new Float64Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        normalized[i] = transform(samples[i]!, raw.unit);
      }
      samples = normalized;
    }

    builderInputs.push({ name: canonical, frequency: raw.frequency, samples });
  }

  // Keep unresolved channels as custom (accessible by prefixed sanitized name)
  const canonicalNames = new Set(Object.keys(CHANNEL_PRIORITIES));
  const assignedNames = new Set(resolved.keys());
  for (let i = 0; i < rawChannels.length; i++) {
    if (usedIndices.has(i)) continue;
    const raw = rawChannels[i]!;
    let safeName = raw.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    if (canonicalNames.has(safeName) || assignedNames.has(safeName)) {
      safeName = CUSTOM_CHANNEL_PREFIX + safeName;
    }
    if (assignedNames.has(safeName)) {
      safeName = safeName + '_' + i;
    }
    assignedNames.add(safeName);
    builderInputs.push({ name: safeName, frequency: raw.frequency, samples: raw.samples });
  }

  return builderInputs;
}

/** Stage 6: Ensure distance channel is populated (integrate from speed if needed). */
function ensureDistance(
  matrix: ChannelMatrix,
  warnings: SessionWarning[],
): void {
  const distRow = matrix.channels[CH_DISTANCE];
  const speedRow = matrix.channels[CH_SPEED];
  const hasDistData = distRow.some((v) => v !== 0);
  if (!hasDistData) {
    const integrated = integrateSpeed(speedRow, matrix.sampleRate);
    distRow.set(integrated);
    warnings.push({
      code: 'distance-channel-missing',
      message: 'No distance channel found; integrated from speed',
    });
  }
}

/** Stage 7: Compute track position from GPS arc-length or distance. */
function computeTrackPosition(
  matrix: ChannelMatrix,
  has: ChannelAvailability,
  warnings: SessionWarning[],
): PositionSource {
  let positionSource: PositionSource = 'distance';
  const speedRow = matrix.channels[CH_SPEED];

  if (has.gps) {
    const latRow = matrix.row('gpsLat')!;
    const lonRow = matrix.row('gpsLon')!;

    // Detect and convert coordinate system
    const coordSys = detectCoordinateSystem(latRow, lonRow);
    if (coordSys !== 'decimal') {
      const convertedLat = convertCoordinates(latRow, coordSys);
      const convertedLon = convertCoordinates(lonRow, coordSys);
      latRow.set(convertedLat);
      lonRow.set(convertedLon);
      warnings.push({
        code: 'coordinate-conversion',
        message: `GPS coordinates converted from ${coordSys} to decimal degrees`,
      });
    }

    // Filter GPS quality
    const sats = matrix.row('gpsSatellites');
    const fix = matrix.row('gpsFix');
    const filterResult = filterGpsForArcLength(
      latRow, lonRow, speedRow, matrix.sampleRate, sats, fix,
    );

    if (filterResult.invalidCount > latRow.length * GPS_INVALID_FRACTION_THRESHOLD) {
      warnings.push({
        code: 'gps-quality-poor',
        message: `${filterResult.invalidCount}/${latRow.length} GPS samples invalid; falling back to distance`,
      });
    } else {
      // Smooth GPS
      const smoothed = smoothGps(latRow, lonRow, speedRow, filterResult.valid, matrix.sampleRate, sats);
      latRow.set(smoothed.lat);
      lonRow.set(smoothed.lon);

      // Compute arc length
      const arcLengths = computeGpsArcLength(
        smoothed.lat, smoothed.lon, speedRow,
        matrix.sampleRate, filterResult.valid,
      );

      // Fill track position from GPS arc length
      const tpRow = matrix.channels[CH_TRACK_POSITION];
      const totalArc = arcLengths[arcLengths.length - 1];
      if (totalArc > 0) {
        for (let i = 0; i < arcLengths.length; i++) {
          tpRow[i] = arcLengths[i] / totalArc;
        }
        positionSource = 'gps';
      }
    }
  }

  if (positionSource === 'distance') {
    const tpRow = matrix.channels[CH_TRACK_POSITION];
    const distRow = matrix.channels[CH_DISTANCE];
    const totalDist = distRow[distRow.length - 1] - distRow[0];
    if (totalDist > 0) {
      const baseDist = distRow[0];
      for (let i = 0; i < distRow.length; i++) {
        tpRow[i] = (distRow[i] - baseDist) / totalDist;
      }
    } else {
      positionSource = 'speed-integrated';
    }
  }

  return positionSource;
}

// ── Session class ─────────────────────────────────────────────────────

export class Session {
  readonly id: string;
  readonly fileURL: string;
  readonly format: SessionFormat;
  readonly driver: string;
  readonly driverId: number | null;
  readonly vehicle: string;
  readonly track: string;
  readonly date: Date;
  readonly sampleRate: number;

  readonly laps: ReadonlyArray<Lap>;
  readonly lapCount: number;
  readonly has: ChannelAvailability;
  readonly circuit: CircuitInfo | null;
  readonly totalDuration: number;
  readonly totalDistance: number;
  readonly warnings: ReadonlyArray<SessionWarning>;
  readonly video: VideoAttachment;

  /** @internal */
  readonly matrix: ChannelMatrix;

  constructor(data: SessionData) {
    this.fileURL = data.fileURL;
    this.format = data.format;
    this.driver = data.driver;
    this.vehicle = data.vehicle;
    this.track = data.track;
    this.date = data.date;
    this.circuit = data.circuit;
    this.driverId = data.driverId ?? null;

    const warnings = [...data.warnings];

    // ── 1-3. Resolve and validate channels ──────────────────────
    const { resolved, warnings: resolveWarnings } = resolveAndValidateChannels(
      data.rawChannels, data.format, data.fileURL, warnings,
    );
    warnings.push(...resolveWarnings);

    // ── 4. Build matrix inputs ──────────────────────────────────
    const builderInputs = buildMatrixInputs(data.rawChannels, resolved);

    // ── 5. Build channel matrix ─────────────────────────────────
    this.matrix = buildChannelMatrix(builderInputs);
    this.sampleRate = this.matrix.sampleRate;
    this.has = this.matrix.availability;

    // ── 6. Ensure distance channel ──────────────────────────────
    ensureDistance(this.matrix, warnings);

    // ── 7. Compute track position ───────────────────────────────
    const positionSource = computeTrackPosition(this.matrix, this.has, warnings);

    // ── 8. Build laps ───────────────────────────────────────────
    const lapInfos = buildLaps(this.matrix, data.lapBoundaries, positionSource, data.circuit);
    this.laps = lapInfos.map((info) => new Lap(this.matrix, info));
    this.lapCount = this.laps.length;

    if (this.lapCount === 0) {
      warnings.push({ code: 'no-lap-boundaries', message: 'No laps detected' });
    }

    // ── 9. Session-level stats ──────────────────────────────────
    this.totalDuration = this.matrix.duration;
    const distRow = this.matrix.channels[CH_DISTANCE];
    const rawDist = distRow[distRow.length - 1]! - distRow[0]!;
    this.totalDistance = Number.isFinite(rawDist) ? rawDist : 0;
    this.warnings = warnings;

    // ── 10. Video attachment ────────────────────────────────────
    this.video = buildVideoAttachment({
      telemetryPath: data.fileURL,
      format: data.format,
      sessionDuration: this.totalDuration,
      vboAviFileIndex: data.vboAviFileIndex,
      vboAviSyncTime: data.vboAviSyncTime,
      sessionStartUnix: data.sessionStartUnix,
      sampleCount: this.matrix.sampleCount,
      sessionTimeChannel: this.matrix.channels[CH_TIME],
    });

    // ── 11. Session ID ──────────────────────────────────────────
    this.id = createHash('sha256')
      .update(`${data.fileURL}:${data.format}:${this.totalDuration}`)
      .digest('hex')
      .slice(0, 16);
  }

  lap(index: number): Lap {
    if (index < 0 || index >= this.laps.length) {
      throw new RangeError(`Lap index ${index} out of range [0, ${this.laps.length})`);
    }
    return this.laps[index];
  }

  lapByNumber(lapNumber: number): Lap | null {
    return this.laps.find((l) => l.lapNumber === lapNumber) ?? null;
  }

  timedLaps(): Lap[] {
    return this.laps.filter(
      (l) => l.kind === LapKind.Flying || l.kind === LapKind.FirstFlying,
    );
  }

  fastestLap(): Lap | null {
    const timed = this.timedLaps();
    if (timed.length === 0) return null;
    return timed.reduce((best, l) => (l.lapTime < best.lapTime ? l : best));
  }

  stints(): Stint[] {
    const stints: Stint[] = [];
    let currentStint: {
      outLap: LapInfo | null;
      laps: Lap[];
      inLap: LapInfo | null;
    } = { outLap: null, laps: [], inLap: null };
    let stintNumber = 0;

    for (const lap of this.laps) {
      if (lap.kind === LapKind.OutLap) {
        if (currentStint.laps.length > 0) {
          stintNumber++;
          stints.push(this._buildStint(stintNumber, currentStint));
          currentStint = { outLap: null, laps: [], inLap: null };
        }
        currentStint.outLap = lap;
      } else if (lap.kind === LapKind.InLap) {
        currentStint.inLap = lap;
        stintNumber++;
        stints.push(this._buildStint(stintNumber, currentStint));
        currentStint = { outLap: null, laps: [], inLap: null };
      } else if (lap.kind === LapKind.Flying || lap.kind === LapKind.FirstFlying) {
        currentStint.laps.push(lap);
      }
    }

    // Flush remaining
    if (currentStint.laps.length > 0) {
      stintNumber++;
      stints.push(this._buildStint(stintNumber, currentStint));
    }

    return stints;
  }

  // ── Export ──────────────────────────────────────────────────────────

  /** Export this session as a .vbo file. */
  async saveVbo(directory: string, filename: string): Promise<string> {
    const { saveVbo } = await import('./writers/vbo');
    return saveVbo(this, directory, filename);
  }

  /** Export this session as a .vbo file with associated video files. */
  async saveVboAndVideo(directory: string, filename: string): Promise<{ vboPath: string; videoPaths: string[] }> {
    const { saveVboAndVideo } = await import('./writers/vbo');
    return saveVboAndVideo(this, directory, filename);
  }

  private _buildStint(
    stintNumber: number,
    data: { outLap: LapInfo | null; laps: Lap[]; inLap: LapInfo | null },
  ): Stint {
    const fastest = data.laps.length > 0
      ? data.laps.reduce((best, l) => (l.lapTime < best.lapTime ? l : best))
      : null;
    return {
      stintNumber,
      outLap: data.outLap,
      inLap: data.inLap,
      laps: data.laps,
      fastestLap: fastest,
    };
  }
}
