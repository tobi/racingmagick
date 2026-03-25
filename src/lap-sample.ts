import { ChannelMatrix } from './channel-matrix';
import { CH_TIME, CH_DISTANCE, CH_TRACK_POSITION, CH_SPEED, CH_THROTTLE } from './types';

/**
 * Zero-allocation view into the channel matrix at a given sample index.
 * Property access reads matrix.channels[ch][idx] directly.
 *
 * Supports linear interpolation between two samples when constructed
 * with (matrix, loIdx, hiIdx, fraction). The fraction 0.0 = lo, 1.0 = hi.
 */
export class LapSample {
  /** @internal */
  constructor(
    private readonly matrix: ChannelMatrix,
    private readonly idx: number,
    private readonly hiIdx?: number,
    private readonly frac?: number,
  ) {}

  /** Read a channel value, with linear interpolation if this is an interpolated sample. */
  private _val(chIdx: number): number {
    const v = this.matrix.channels[chIdx][this.idx];
    if (this.hiIdx !== undefined && this.frac !== undefined && this.frac > 0) {
      return v + (this.matrix.channels[chIdx][this.hiIdx] - v) * this.frac;
    }
    return v;
  }

  // Required channels — direct array access, no branching
  get time(): number {
    return this._val(CH_TIME);
  }
  get distance(): number {
    return this._val(CH_DISTANCE);
  }
  get trackPosition(): number {
    return this._val(CH_TRACK_POSITION);
  }
  get speed(): number {
    return this._val(CH_SPEED);
  }
  get throttle(): number {
    return this._val(CH_THROTTLE);
  }

  // Optional channels — null if channel doesn't exist
  private _opt(name: string): number | null {
    const chIdx = this.matrix.nameToIndex.get(name);
    if (chIdx === undefined) return null;
    const v = this.matrix.channels[chIdx][this.idx];
    if (this.hiIdx !== undefined && this.frac !== undefined && this.frac > 0) {
      return v + (this.matrix.channels[chIdx][this.hiIdx] - v) * this.frac;
    }
    return v;
  }

  get rpm(): number | null { return this._opt('rpm'); }
  get gear(): number | null { return this._opt('gear'); }
  get throttleActual(): number | null { return this._opt('throttleActual'); }
  get brakePedal(): number | null { return this._opt('brakePedal'); }
  get brakePressure(): number | null { return this._opt('brakePressure'); }
  get brakePressureRear(): number | null { return this._opt('brakePressureRear'); }
  get clutchPedal(): number | null { return this._opt('clutchPedal'); }
  get clutchActual(): number | null { return this._opt('clutchActual'); }
  get steering(): number | null { return this._opt('steering'); }
  get tcCut(): number | null { return this._opt('tcCut'); }
  get tcSlip(): number | null { return this._opt('tcSlip'); }
  get gLong(): number | null { return this._opt('gLong'); }
  get gLat(): number | null { return this._opt('gLat'); }
  get heading(): number | null { return this._opt('heading'); }
  get yawRate(): number | null { return this._opt('yawRate'); }

  get gpsLat(): number | null { return this._opt('gpsLat'); }
  get gpsLon(): number | null { return this._opt('gpsLon'); }
  get gpsAlt(): number | null { return this._opt('gpsAlt'); }
  get gpsSpeed(): number | null { return this._opt('gpsSpeed'); }
  get gpsSatellites(): number | null { return this._opt('gpsSatellites'); }
  get gpsFix(): number | null { return this._opt('gpsFix'); }

  get wheelSpeedFL(): number | null { return this._opt('wheelSpeedFL'); }
  get wheelSpeedFR(): number | null { return this._opt('wheelSpeedFR'); }
  get wheelSpeedRL(): number | null { return this._opt('wheelSpeedRL'); }
  get wheelSpeedRR(): number | null { return this._opt('wheelSpeedRR'); }

  get damperFL(): number | null { return this._opt('damperFL'); }
  get damperFR(): number | null { return this._opt('damperFR'); }
  get damperRL(): number | null { return this._opt('damperRL'); }
  get damperRR(): number | null { return this._opt('damperRR'); }

  // Tire pressures (bar)
  get tirePressureFL(): number | null { return this._opt('tirePressureFL'); }
  get tirePressureFR(): number | null { return this._opt('tirePressureFR'); }
  get tirePressureRL(): number | null { return this._opt('tirePressureRL'); }
  get tirePressureRR(): number | null { return this._opt('tirePressureRR'); }

  // Tire temperatures (°C)
  get tireTempFL(): number | null { return this._opt('tireTempFL'); }
  get tireTempFR(): number | null { return this._opt('tireTempFR'); }
  get tireTempRL(): number | null { return this._opt('tireTempRL'); }
  get tireTempRR(): number | null { return this._opt('tireTempRR'); }

  // Tire slip angles (degrees)
  get tireSlipAngleFL(): number | null { return this._opt('tireSlipAngleFL'); }
  get tireSlipAngleFR(): number | null { return this._opt('tireSlipAngleFR'); }
  get tireSlipAngleRL(): number | null { return this._opt('tireSlipAngleRL'); }
  get tireSlipAngleRR(): number | null { return this._opt('tireSlipAngleRR'); }

  // Tire slip ratios (dimensionless)
  get tireSlipRatioFL(): number | null { return this._opt('tireSlipRatioFL'); }
  get tireSlipRatioFR(): number | null { return this._opt('tireSlipRatioFR'); }
  get tireSlipRatioRL(): number | null { return this._opt('tireSlipRatioRL'); }
  get tireSlipRatioRR(): number | null { return this._opt('tireSlipRatioRR'); }

  // Tire wear (0.0–1.0)
  get tireWearFL(): number | null { return this._opt('tireWearFL'); }
  get tireWearFR(): number | null { return this._opt('tireWearFR'); }
  get tireWearRL(): number | null { return this._opt('tireWearRL'); }
  get tireWearRR(): number | null { return this._opt('tireWearRR'); }

  // Tire load (N)
  get tireLoadFL(): number | null { return this._opt('tireLoadFL'); }
  get tireLoadFR(): number | null { return this._opt('tireLoadFR'); }
  get tireLoadRL(): number | null { return this._opt('tireLoadRL'); }
  get tireLoadRR(): number | null { return this._opt('tireLoadRR'); }

  // Derived
  get tcActive(): boolean {
    const actual = this.throttleActual;
    return actual !== null && this.throttle - actual > 0.02;
  }
}

/**
 * A range view [startIdx, endIdx) into the channel matrix.
 * Zero-copy — just two integers.
 */
export class LapSampleSlice implements Iterable<LapSample> {
  constructor(
    private readonly matrix: ChannelMatrix,
    readonly startIdx: number,
    readonly endIdx: number,
  ) {}

  get length(): number {
    return this.endIdx - this.startIdx;
  }

  at(offset: number): LapSample {
    const idx = this.startIdx + offset;
    if (idx < this.startIdx || idx >= this.endIdx) {
      throw new RangeError(`Sample offset ${offset} out of range [0, ${this.length})`);
    }
    return new LapSample(this.matrix, idx);
  }

  *[Symbol.iterator](): Iterator<LapSample> {
    for (let i = this.startIdx; i < this.endIdx; i++) {
      yield new LapSample(this.matrix, i);
    }
  }

  /** Get a single channel across this slice as a subarray (zero-copy). */
  channel(name: string): Float64Array | null {
    const row = this.matrix.row(name);
    return row ? row.subarray(this.startIdx, this.endIdx) : null;
  }
}
