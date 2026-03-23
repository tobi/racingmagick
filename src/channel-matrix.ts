import { CH_TIME, CH_DISTANCE, CH_TRACK_POSITION, CH_SPEED, CH_THROTTLE, WELL_KNOWN_CHANNELS } from './types';
import type { ChannelAvailability } from './types';

/**
 * The core data structure. One per session, shared by all laps.
 * Laps are just (startIndex, endIndex) ranges into the same matrix.
 *
 * channels[ch][i] = value of channel `ch` at sample `i`.
 * All channels are at constant Hz after resampling.
 */
export class ChannelMatrix {
  readonly channels: Float64Array[];
  readonly sampleCount: number;
  readonly sampleRate: number;
  readonly nameToIndex: ReadonlyMap<string, number>;
  readonly indexToName: readonly string[];
  private _has: ChannelAvailability | null = null;

  constructor(
    channels: Float64Array[],
    sampleRate: number,
    nameToIndex: Map<string, number>,
  ) {
    if (channels.length === 0) {
      throw new Error('ChannelMatrix requires at least one channel');
    }
    this.sampleCount = channels[0].length;
    // Validate all channels have same length
    for (let i = 1; i < channels.length; i++) {
      if (channels[i].length !== this.sampleCount) {
        throw new Error(
          `Channel ${i} has ${channels[i].length} samples, expected ${this.sampleCount}`,
        );
      }
    }
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.nameToIndex = nameToIndex;

    // Build reverse map
    const names = new Array<string>(channels.length).fill('');
    for (const [name, idx] of nameToIndex) {
      names[idx] = name;
    }
    this.indexToName = names;
  }

  has(name: string): boolean {
    return this.nameToIndex.has(name);
  }

  row(name: string): Float64Array | null {
    const idx = this.nameToIndex.get(name);
    return idx !== undefined ? this.channels[idx] : null;
  }

  /** Compute channel availability flags. Cached after first call. */
  get availability(): ChannelAvailability {
    if (this._has) return this._has;
    this._has = {
      gps: this.has('gpsLat') && this.has('gpsLon'),
      gpsAlt: this.has('gpsAlt'),
      gpsSpeed: this.has('gpsSpeed'),
      gpsSatellites: this.has('gpsSatellites'),
      gpsFix: this.has('gpsFix'),
      rpm: this.has('rpm'),
      gear: this.has('gear'),
      throttleActual: this.has('throttleActual'),
      brakePedal: this.has('brakePedal'),
      brakePressure: this.has('brakePressure'),
      brakePressureRear: this.has('brakePressureRear'),
      clutchPedal: this.has('clutchPedal'),
      clutchActual: this.has('clutchActual'),
      steering: this.has('steering'),
      tcCut: this.has('tcCut'),
      tcSlip: this.has('tcSlip'),
      gLong: this.has('gLong'),
      gLat: this.has('gLat'),
      heading: this.has('heading'),
      yawRate: this.has('yawRate'),
      wheelSpeeds:
        this.has('wheelSpeedFL') &&
        this.has('wheelSpeedFR') &&
        this.has('wheelSpeedRL') &&
        this.has('wheelSpeedRR'),
      dampers:
        this.has('damperFL') &&
        this.has('damperFR') &&
        this.has('damperRL') &&
        this.has('damperRR'),
      tirePressures:
        this.has('tirePressureFL') &&
        this.has('tirePressureFR') &&
        this.has('tirePressureRL') &&
        this.has('tirePressureRR'),
      tireTemps:
        this.has('tireTempFL') &&
        this.has('tireTempFR') &&
        this.has('tireTempRL') &&
        this.has('tireTempRR'),
      tireSlipAngles:
        this.has('tireSlipAngleFL') &&
        this.has('tireSlipAngleFR') &&
        this.has('tireSlipAngleRL') &&
        this.has('tireSlipAngleRR'),
      tireSlipRatios:
        this.has('tireSlipRatioFL') &&
        this.has('tireSlipRatioFR') &&
        this.has('tireSlipRatioRL') &&
        this.has('tireSlipRatioRR'),
      tireWear:
        this.has('tireWearFL') &&
        this.has('tireWearFR') &&
        this.has('tireWearRL') &&
        this.has('tireWearRR'),
      tireLoads:
        this.has('tireLoadFL') &&
        this.has('tireLoadFR') &&
        this.has('tireLoadRL') &&
        this.has('tireLoadRR'),
    };
    return this._has;
  }

  /** Duration of the entire matrix in seconds. */
  get duration(): number {
    if (this.sampleCount === 0) return 0;
    return this.channels[CH_TIME][this.sampleCount - 1] - this.channels[CH_TIME][0];
  }
}

// ── Builder ──────────────────────────────────────────────────────────

export interface ChannelMatrixBuilderInput {
  name: string; // canonical channel name
  frequency: number; // source Hz
  samples: Float64Array;
}

/**
 * Build a ChannelMatrix from heterogeneous-rate channels.
 * All channels are resampled to `targetHz` using linear interpolation
 * (nearest-neighbor for discrete channels like gear).
 */
export function buildChannelMatrix(
  inputs: ChannelMatrixBuilderInput[],
  targetHz?: number,
): ChannelMatrix {
  if (inputs.length === 0) {
    throw new Error('No channels provided');
  }

  // Find the max source frequency
  let maxFreq = 0;
  for (const ch of inputs) {
    if (ch.frequency > maxFreq) maxFreq = ch.frequency;
  }

  // Cap at 100Hz by default
  const hz = targetHz ?? Math.min(maxFreq, 100);
  if (hz <= 0) throw new Error(`Invalid target frequency: ${hz}`);

  // Determine total duration from the highest-rate channel
  let maxDuration = 0;
  for (const ch of inputs) {
    const dur = (ch.samples.length - 1) / ch.frequency;
    if (dur > maxDuration) maxDuration = dur;
  }

  const outputCount = Math.floor(maxDuration * hz) + 1;
  if (outputCount <= 0) throw new Error('Zero-length output after resampling');

  // Discrete channels use nearest-neighbor interpolation
  const DISCRETE_CHANNELS = new Set(['gear', 'lapNumber', 'carOnJack', 'gpsFix', 'gpsSatellites']);

  // Allocate well-known channels first (indices 0-4)
  const nameToIndex = new Map<string, number>();
  const channelArrays: Float64Array[] = [];

  // Reserve slots for well-known channels
  for (let i = 0; i < WELL_KNOWN_CHANNELS.length; i++) {
    nameToIndex.set(WELL_KNOWN_CHANNELS[i], i);
    channelArrays.push(new Float64Array(outputCount));
  }

  // Process each input channel
  for (const input of inputs) {
    let idx = nameToIndex.get(input.name);
    if (idx === undefined) {
      idx = channelArrays.length;
      nameToIndex.set(input.name, idx);
      channelArrays.push(new Float64Array(outputCount));
    }

    const out = channelArrays[idx];
    const isDiscrete = DISCRETE_CHANNELS.has(input.name);

    if (input.frequency === hz && input.samples.length === outputCount) {
      // No resampling needed
      out.set(input.samples);
    } else {
      // Resample
      resampleChannel(input.samples, input.frequency, out, hz, isDiscrete);
    }
  }

  // If time channel wasn't explicitly provided, generate it
  if (!inputs.some((ch) => ch.name === 'time')) {
    const timeArr = channelArrays[CH_TIME];
    for (let i = 0; i < outputCount; i++) {
      timeArr[i] = i / hz;
    }
  }

  return new ChannelMatrix(channelArrays, hz, nameToIndex);
}

function resampleChannel(
  src: Float64Array,
  srcHz: number,
  dst: Float64Array,
  dstHz: number,
  discrete: boolean,
): void {
  const srcCount = src.length;
  if (srcCount === 0) return;
  if (srcCount === 1) {
    dst.fill(src[0]);
    return;
  }

  for (let i = 0; i < dst.length; i++) {
    const t = i / dstHz; // seconds
    const srcPos = t * srcHz; // fractional source index

    // Clamp to valid source range — hold last value for shorter channels
    const lo = Math.min(Math.floor(srcPos), srcCount - 1);
    const hi = Math.min(lo + 1, srcCount - 1);

    if (discrete) {
      // Nearest-neighbor
      dst[i] = srcPos - lo < 0.5 ? src[lo]! : src[hi]!;
    } else {
      // Linear interpolation
      const frac = Math.min(srcPos - lo, 1);
      dst[i] = src[lo]! + (src[hi]! - src[lo]!) * frac;
    }
  }
}
