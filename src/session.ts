import { createHash } from 'crypto';
import { ChannelMatrix, buildChannelMatrix } from './channel-matrix';
import type { ChannelMatrixBuilderInput } from './channel-matrix';
import { Lap } from './lap';
import { buildLaps } from './lap-classification';
import { resolveAllChannels, resolveThrottleChannels } from './channels';
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

export class Session {
  readonly id: string;
  readonly fileURL: string;
  readonly format: SessionFormat;
  readonly driver: string;
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

    const warnings = [...data.warnings];

    // ── 1. Resolve channels via priority table ─────────────────────
    // resolveAllChannels walks each canonical channel's priority list
    // and picks the first matching raw channel. Returns canonical → { rawIndex, transform }.
    const resolved = resolveAllChannels(data.rawChannels);

    // ── 2. Throttle resolution (fallback if no driver throttle) ──
    const tResult = resolveThrottleChannels(resolved);
    if (tResult.warning) {
      warnings.push({ code: 'throttle-fallback', message: tResult.warning });
    }

    // ── 3. Validate required channels ─────────────────────────────
    if (!resolved.has('speed')) {
      throw new ParseError(`No speed channel found in ${data.fileURL}`, data.format);
    }
    if (!resolved.has('throttle')) {
      throw new ParseError(`No throttle channel found in ${data.fileURL}`, data.format);
    }

    // ── 4. Build matrix inputs: apply transforms, add custom channels ──
    const builderInputs: ChannelMatrixBuilderInput[] = [];
    const usedIndices = new Set<number>();

    for (const [canonical, { rawIndex, transform }] of resolved) {
      const raw = data.rawChannels[rawIndex]!;
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

    // Keep unresolved channels as custom (accessible by sanitized name)
    for (let i = 0; i < data.rawChannels.length; i++) {
      if (usedIndices.has(i)) continue;
      const raw = data.rawChannels[i]!;
      const safeName = raw.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
      builderInputs.push({ name: safeName, frequency: raw.frequency, samples: raw.samples });
    }

    // ── 5. Build channel matrix ───────────────────────────────────
    this.matrix = buildChannelMatrix(builderInputs);
    this.sampleRate = this.matrix.sampleRate;
    this.has = this.matrix.availability;

    // ── 6. Compute distance if missing ────────────────────────────
    if (!this.matrix.has('distance')) {
      // No explicit check needed — buildChannelMatrix always allocates slot 1
      // but we need to fill it from speed integration
    }
    const distRow = this.matrix.channels[CH_DISTANCE];
    const speedRow = this.matrix.channels[CH_SPEED];
    const hasDistData = distRow.some((v) => v !== 0);
    if (!hasDistData) {
      // Integrate speed to get distance
      const integrated = integrateSpeed(speedRow, this.matrix.sampleRate);
      distRow.set(integrated);
      warnings.push({
        code: 'distance-channel-missing',
        message: 'No distance channel found; integrated from speed',
      });
    }

    // ── 7. Compute track position ─────────────────────────────────
    let positionSource: PositionSource = 'distance';

    if (this.has.gps) {
      const latRow = this.matrix.row('gpsLat')!;
      const lonRow = this.matrix.row('gpsLon')!;

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
      const sats = this.matrix.row('gpsSatellites');
      const fix = this.matrix.row('gpsFix');
      const filterResult = filterGpsForArcLength(
        latRow, lonRow, speedRow, this.matrix.sampleRate, sats, fix,
      );

      if (filterResult.invalidCount > latRow.length * 0.5) {
        warnings.push({
          code: 'gps-quality-poor',
          message: `${filterResult.invalidCount}/${latRow.length} GPS samples invalid; falling back to distance`,
        });
      } else {
        // Smooth GPS
        const smoothed = smoothGps(latRow, lonRow, speedRow, filterResult.valid, this.matrix.sampleRate, sats);
        latRow.set(smoothed.lat);
        lonRow.set(smoothed.lon);

        // Compute arc length
        const arcLengths = computeGpsArcLength(
          smoothed.lat as any, smoothed.lon as any, speedRow,
          this.matrix.sampleRate, filterResult.valid,
        );

        // Fill track position from GPS arc length
        const tpRow = this.matrix.channels[CH_TRACK_POSITION];
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
      // Track position from distance channel
      const tpRow = this.matrix.channels[CH_TRACK_POSITION];
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

    // ── 8. Build laps ─────────────────────────────────────────────
    const lapInfos = buildLaps(this.matrix, data.lapBoundaries, positionSource);
    this.laps = lapInfos.map((info) => new Lap(this.matrix, info));
    this.lapCount = this.laps.length;

    if (this.lapCount === 0) {
      warnings.push({ code: 'no-lap-boundaries', message: 'No laps detected' });
    }

    // ── 9. Session-level stats ────────────────────────────────────
    this.totalDuration = this.matrix.duration;
    const rawDist = distRow[distRow.length - 1]! - distRow[0]!;
    this.totalDistance = Number.isFinite(rawDist) ? rawDist : 0;
    this.warnings = warnings;

    // ── 10. Video attachment ────────────────────────────────────────
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

    // ── 11. Session ID ────────────────────────────────────────────
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
        // Start new stint
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
  saveVbo(directory: string, filename: string): string {
    const { saveVbo } = require('./writers/vbo');
    return saveVbo(this, directory, filename);
  }

  /** Export this session as a .vbo file with associated video files. */
  saveVboAndVideo(directory: string, filename: string): { vboPath: string; videoPaths: string[] } {
    const { saveVboAndVideo } = require('./writers/vbo');
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
