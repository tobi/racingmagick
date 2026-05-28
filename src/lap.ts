import { ChannelMatrix } from './channel-matrix';
import type { ChannelInfo } from './channel-matrix';
import { LapSample, LapSampleSlice } from './lap-sample';
import { CH_TRACK_POSITION, CH_TIME, CH_DISTANCE, CH_SPEED } from './types';
import type { LapInfo, ChannelAvailability, LapDelta, PositionSource, SectorTime, LapError as LapErrorType } from './types';
import { LapError } from './types';
import { SPEED_BIAS_ALPHA, SPEED_BIAS_LOOKBACK } from './constants';

/**
 * A Lap is a range [startIdx, endIdx) into a Session's ChannelMatrix,
 * plus computed metadata.
 */
export class Lap {
  /** @internal */
  readonly matrix: ChannelMatrix;
  readonly startIdx: number;
  readonly endIdx: number;

  // Identity
  readonly lapIndex: number;
  readonly lapNumber: number | null;
  readonly displayLabel: string;
  readonly kind: LapInfo['kind'];

  // Timing
  readonly lapTime: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly sampleRate: number;
  readonly sampleCount: number;
  readonly totalDistance: number;

  readonly sectors: ReadonlyArray<SectorTime> | null;
  readonly positionSource: PositionSource;
  readonly has: ChannelAvailability;

  constructor(matrix: ChannelMatrix, info: LapInfo) {
    this.matrix = matrix;
    this.startIdx = info.startIdx;
    this.endIdx = info.endIdx;
    this.lapIndex = info.lapIndex;
    this.lapNumber = info.lapNumber;
    this.displayLabel = info.displayLabel;
    this.kind = info.kind;
    this.lapTime = info.lapTime;
    this.startTime = info.startTime;
    this.endTime = info.endTime;
    this.sampleRate = info.sampleRate;
    this.sampleCount = info.sampleCount;
    this.totalDistance = info.totalDistance;
    this.sectors = info.sectors;
    this.positionSource = info.positionSource;
    this.has = matrix.availability;

    if (this.sampleCount === 0) {
      throw new LapError('Lap has zero duration');
    }
  }

  get samples(): LapSampleSlice {
    return new LapSampleSlice(this.matrix, this.startIdx, this.endIdx);
  }

  channelNames(): string[] {
    return this.matrix.channelNames();
  }

  hasChannel(name: string): boolean {
    return this.matrix.has(name);
  }

  /** Raw channel data for this lap — subarray view, zero copy. */
  channel(name: string): Float64Array | null {
    const row = this.matrix.row(name);
    return row ? row.subarray(this.startIdx, this.endIdx) : null;
  }

  channelOrThrow(name: string): Float64Array {
    const row = this.channel(name);
    if (!row) throw new RangeError(`Channel not found: ${name}`);
    return row;
  }

  channelInfo(name: string): ChannelInfo | null {
    const info = this.matrix.channelInfo(name);
    if (!info) return null;
    return { ...info, sampleCount: this.sampleCount };
  }

  /** Get interpolated sample at a track position (0.0–1.0). */
  at(trackPosition: number): LapSample {
    const pos = Math.max(0, Math.min(1, trackPosition));
    const tpArr = this.matrix.channels[CH_TRACK_POSITION];

    // Binary search for bracketing samples within this lap
    const [lo, hi] = this._findBracket(tpArr, pos);

    if (lo === hi) {
      return new LapSample(this.matrix, lo);
    }

    const span = tpArr[hi] - tpArr[lo];
    const rawFraction = span > 0 ? (pos - tpArr[lo]) / span : 0;

    // Speed-aware bias: adjusts the interpolation fraction so that slower
    // sections (corners) get more weight — reflecting time spent there.
    const t = this._lerpWithSpeedBias(lo, hi, rawFraction);

    // True linear interpolation: return an interpolated sample that blends
    // lo and hi values by the biased fraction t.
    return new LapSample(this.matrix, lo, hi, t);
  }

  /** Get N evenly-spaced samples across the lap by track position. */
  resample(count: number): LapSample[] {
    const samples: LapSample[] = [];
    for (let i = 0; i < count; i++) {
      const pos = i / (count - 1);
      samples.push(this.at(pos));
    }
    return samples;
  }

  /** Get all original-rate samples within a track position range. */
  slice(fromPosition: number, toPosition: number): LapSampleSlice {
    const tpArr = this.matrix.channels[CH_TRACK_POSITION];
    let start = this.startIdx;
    let end = this.endIdx;

    // Find start index
    for (let i = this.startIdx; i < this.endIdx; i++) {
      if (tpArr[i] >= fromPosition) { start = i; break; }
    }
    // Find end index
    for (let i = this.endIdx - 1; i >= this.startIdx; i--) {
      if (tpArr[i] <= toPosition) { end = i + 1; break; }
    }

    return new LapSampleSlice(this.matrix, start, end);
  }

  /** Get a single channel resampled to N evenly-spaced track positions. */
  channelAtPositions(name: string, resolution: number = 1000): Float64Array {
    const row = this.matrix.row(name);
    if (!row) return new Float64Array(resolution).fill(NaN);

    const result = new Float64Array(resolution);
    const tpArr = this.matrix.channels[CH_TRACK_POSITION];

    for (let i = 0; i < resolution; i++) {
      const pos = i / (resolution - 1);
      const [lo, hi] = this._findBracket(tpArr, pos);
      const span = tpArr[hi] - tpArr[lo];
      const frac = span > 0 ? (pos - tpArr[lo]) / span : 0;
      result[i] = row[lo] + (row[hi] - row[lo]) * frac;
    }

    return result;
  }

  /** Sample at elapsed time (seconds from lap start). */
  atTime(seconds: number): LapSample {
    const timeArr = this.matrix.channels[CH_TIME];
    const targetTime = this.startTime + seconds;
    const [lo, hi] = this._findBracketInRange(timeArr, targetTime, this.startIdx, this.endIdx);
    return new LapSample(this.matrix, lo);
  }

  /** Sample at cumulative distance (meters from lap start). */
  atByDistance(meters: number): LapSample {
    const distArr = this.matrix.channels[CH_DISTANCE];
    const targetDist = distArr[this.startIdx] + meters;
    const [lo] = this._findBracketInRange(distArr, targetDist, this.startIdx, this.endIdx);
    return new LapSample(this.matrix, lo);
  }

  /** Slice by raw distance range. */
  sliceByDistance(fromMeters: number, toMeters: number): LapSampleSlice {
    const distArr = this.matrix.channels[CH_DISTANCE];
    const baseDist = distArr[this.startIdx];

    let start = this.startIdx;
    let end = this.endIdx;
    for (let i = this.startIdx; i < this.endIdx; i++) {
      if (distArr[i] - baseDist >= fromMeters) { start = i; break; }
    }
    for (let i = this.endIdx - 1; i >= this.startIdx; i--) {
      if (distArr[i] - baseDist <= toMeters) { end = i + 1; break; }
    }

    return new LapSampleSlice(this.matrix, start, end);
  }

  /** GPS trace as [lat, lon] pairs. Null if no GPS. */
  gpsTrace(): [number, number][] | null {
    const latRow = this.matrix.row('gpsLat');
    const lonRow = this.matrix.row('gpsLon');
    if (!latRow || !lonRow) return null;

    const result: [number, number][] = [];
    for (let i = this.startIdx; i < this.endIdx; i++) {
      result.push([latRow[i], lonRow[i]]);
    }
    return result;
  }

  /** GPS bounding box. Null if no GPS. */
  gpsBounds(): { north: number; south: number; east: number; west: number } | null {
    const trace = this.gpsTrace();
    if (!trace || trace.length === 0) return null;

    let north = -Infinity, south = Infinity, east = -Infinity, west = Infinity;
    for (const [lat, lon] of trace) {
      if (lat > north) north = lat;
      if (lat < south) south = lat;
      if (lon > east) east = lon;
      if (lon < west) west = lon;
    }
    return { north, south, east, west };
  }

  /**
   * Compare this lap against another.
   * Positive delta = this lap is slower at that point.
   */
  delta(other: Lap, options?: { resolution?: number }): LapDelta {
    const resolution = options?.resolution ?? 1000;
    const trace = new Float64Array(resolution);

    const thisTime = this.matrix.channels[CH_TIME];
    const otherTime = other.matrix.channels[CH_TIME];
    const thisTp = this.matrix.channels[CH_TRACK_POSITION];
    const otherTp = other.matrix.channels[CH_TRACK_POSITION];

    let worstPos = 0, bestPos = 0;
    let worstDelta = -Infinity, bestDelta = Infinity;

    for (let i = 0; i < resolution; i++) {
      const pos = i / (resolution - 1);

      // Get elapsed time at this position for both laps
      const [lo1, hi1] = this._findBracket(thisTp, pos);
      const span1 = thisTp[hi1] - thisTp[lo1];
      const frac1 = span1 > 0 ? (pos - thisTp[lo1]) / span1 : 0;
      const t1 = thisTime[lo1] + frac1 * (thisTime[hi1] - thisTime[lo1]) - this.startTime;

      const [lo2, hi2] = other._findBracket(otherTp, pos);
      const span2 = otherTp[hi2] - otherTp[lo2];
      const frac2 = span2 > 0 ? (pos - otherTp[lo2]) / span2 : 0;
      const t2 = otherTime[lo2] + frac2 * (otherTime[hi2] - otherTime[lo2]) - other.startTime;

      trace[i] = (t1 - t2) * 1000; // ms

      if (trace[i] > worstDelta) { worstDelta = trace[i]; worstPos = pos; }
      if (trace[i] < bestDelta) { bestDelta = trace[i]; bestPos = pos; }
    }

    const totalDelta = this.lapTime - other.lapTime;

    return {
      totalDelta,
      worstPosition: worstPos,
      bestPosition: bestPos,
      sectorDeltas: null,
      deltaAt(trackPosition: number): number {
        const idx = Math.round(trackPosition * (resolution - 1));
        return trace[Math.max(0, Math.min(resolution - 1, idx))];
      },
      deltaTrace(res?: number): Float64Array {
        if (!res || res === resolution) return trace;
        // Resample
        const out = new Float64Array(res);
        for (let i = 0; i < res; i++) {
          const srcPos = (i / (res - 1)) * (resolution - 1);
          const lo = Math.floor(srcPos);
          const hi = Math.min(lo + 1, resolution - 1);
          const frac = srcPos - lo;
          out[i] = trace[lo] + frac * (trace[hi] - trace[lo]);
        }
        return out;
      },
    };
  }

  // ── Private helpers ────────────────────────────────────────────────

  /** Binary search for bracket [lo, hi] such that arr[lo] <= target <= arr[hi]. */
  _findBracket(arr: Float64Array, target: number): [number, number] {
    return this._findBracketInRange(arr, target, this.startIdx, this.endIdx);
  }

  _findBracketInRange(arr: Float64Array, target: number, start: number, end: number): [number, number] {
    let lo = start;
    let hi = end - 1;

    if (target <= arr[lo]) return [lo, lo];
    if (target >= arr[hi]) return [hi, hi];

    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] <= target) lo = mid;
      else hi = mid;
    }

    return [lo, hi];
  }

  _lerpWithSpeedBias(lo: number, hi: number, rawFraction: number, alpha: number = SPEED_BIAS_ALPHA): number {
    const speed = this.matrix.channels[CH_SPEED];
    const lookback = SPEED_BIAS_LOOKBACK;

    let ema = speed[Math.max(0, lo - lookback)];
    for (let i = Math.max(0, lo - lookback + 1); i <= lo; i++) {
      ema = alpha * speed[i] + (1 - alpha) * ema;
    }
    const speedLo = ema;

    ema = speedLo;
    for (let i = lo + 1; i <= hi; i++) {
      ema = alpha * speed[i] + (1 - alpha) * ema;
    }
    const speedHi = ema;

    if (speedLo + speedHi < 1e-6) return rawFraction;

    const wLo = 1 / Math.max(speedLo, 1);
    const wHi = 1 / Math.max(speedHi, 1);
    return rawFraction * wHi / (wLo + rawFraction * (wHi - wLo));
  }
}
