// ── Error Types ──────────────────────────────────────────────────────

export class ParseError extends Error {
  constructor(message: string, public readonly format?: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export class LapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LapError';
  }
}

// ── Warnings ─────────────────────────────────────────────────────────

export type WarningCode =
  | 'low-gps-satellites'
  | 'missing-optional-channel'
  | 'suspicious-data-range'
  | 'low-sample-rate'
  | 'gps-quality-poor'
  | 'no-lap-boundaries'
  | 'distance-channel-missing'
  | 'throttle-fallback'
  | 'coordinate-conversion';

export interface SessionWarning {
  readonly code: WarningCode;
  readonly message: string;
  readonly channel?: string;
}

// ── Enums ────────────────────────────────────────────────────────────

export enum LapKind {
  OutLap = 'out-lap',
  InLap = 'in-lap',
  Flying = 'flying',
  FirstFlying = 'first-flying',
  Slow = 'slow',
}

export type SessionFormat = 'motec' | 'pds' | 'vbo';

export type PositionSource = 'gps' | 'distance' | 'speed-integrated';

// ── Well-Known Channel Indices ───────────────────────────────────────
// The first 5 rows are always allocated and always populated.

export const CH_TIME = 0;
export const CH_DISTANCE = 1;
export const CH_TRACK_POSITION = 2;
export const CH_SPEED = 3;
export const CH_THROTTLE = 4;

export const WELL_KNOWN_CHANNELS = ['time', 'distance', 'trackPosition', 'speed', 'throttle'] as const;

// ── Channel Availability ─────────────────────────────────────────────

export interface ChannelAvailability {
  readonly gps: boolean;
  readonly gpsAlt: boolean;
  readonly gpsSpeed: boolean;
  readonly gpsSatellites: boolean;
  readonly gpsFix: boolean;
  readonly rpm: boolean;
  readonly gear: boolean;
  readonly throttleActual: boolean;
  readonly brakePedal: boolean;
  readonly brakePressure: boolean;
  readonly brakePressureRear: boolean;
  readonly clutchPedal: boolean;
  readonly clutchActual: boolean;
  readonly steering: boolean;
  readonly tcCut: boolean;
  readonly tcSlip: boolean;
  readonly gLong: boolean;
  readonly gLat: boolean;
  readonly heading: boolean;
  readonly yawRate: boolean;
  readonly wheelSpeeds: boolean;
  readonly dampers: boolean;
  // Tire pressures (bar)
  readonly tirePressures: boolean;
  // Tire temperatures (°C)
  readonly tireTemps: boolean;
  // Tire slip angles (degrees)
  readonly tireSlipAngles: boolean;
  // Tire slip ratios (dimensionless)
  readonly tireSlipRatios: boolean;
  // Tire wear (0.0–1.0)
  readonly tireWear: boolean;
  // Tire load (N)
  readonly tireLoads: boolean;
}

// ── Circuit Info ─────────────────────────────────────────────────────

export interface TimingLine {
  readonly type: 'start' | 'split';
  readonly name: string;
  readonly start: { lat: number; lon: number };
  readonly end: { lat: number; lon: number };
}

export interface CircuitInfo {
  readonly name: string | null;
  readonly country: string | null;
  readonly timingLines: ReadonlyArray<TimingLine>;
}

// ── Sector Time ──────────────────────────────────────────────────────

export interface SectorTime {
  readonly sector: number;
  readonly name: string;
  readonly time: number; // milliseconds
  readonly startPosition: number; // 0.0–1.0
  readonly endPosition: number; // 0.0–1.0
}

// ── Stint ────────────────────────────────────────────────────────────

export interface Stint {
  readonly stintNumber: number;
  readonly outLap: LapInfo | null;
  readonly inLap: LapInfo | null;
  readonly laps: ReadonlyArray<LapInfo>;
  readonly fastestLap: LapInfo | null;
}

// ── Raw Parsed Channel ───────────────────────────────────────────────
// Intermediate representation from format parsers before normalization.

export interface RawChannel {
  readonly name: string;
  readonly unit: string;
  readonly frequency: number; // Hz
  readonly samples: Float64Array;
}

// ── Lap Boundary ─────────────────────────────────────────────────────

export interface LapBoundary {
  readonly timeSeconds: number;
  /** Index into the highest-rate channel (after resampling). */
  sampleIndex?: number;
}

// ── Session Data (input to Session constructor) ──────────────────────

export interface SessionData {
  readonly format: SessionFormat;
  readonly driver: string;
  readonly vehicle: string;
  readonly track: string;
  readonly date: Date;
  readonly rawChannels: RawChannel[];
  readonly lapBoundaries: LapBoundary[];
  readonly circuit: CircuitInfo | null;
  readonly warnings: SessionWarning[];
  readonly fileURL: string;
  // Video-related (optional, format-specific)
  /** VBO: parsed [AVI] section info */
  readonly vboAviFileIndex?: Float64Array;
  readonly vboAviSyncTime?: Float64Array;
  /** PDS/MoTeC: session start as Unix timestamp (from FIA_GpsTimeUTC or Global Time) */
  readonly sessionStartUnix?: number;
}

// ── Lap Info (public interface for a lap) ────────────────────────────

export interface LapInfo {
  readonly lapIndex: number;
  readonly lapNumber: number | null;
  readonly displayLabel: string;
  readonly kind: LapKind;
  readonly lapTime: number; // milliseconds
  readonly startTime: number;
  readonly endTime: number;
  readonly sampleRate: number;
  readonly sampleCount: number;
  readonly totalDistance: number;
  readonly startIdx: number;
  readonly endIdx: number;
  readonly sectors: ReadonlyArray<SectorTime> | null;
  readonly positionSource: PositionSource;
}

// ── LapDelta ─────────────────────────────────────────────────────────

export interface LapDelta {
  readonly totalDelta: number; // ms
  readonly worstPosition: number; // 0.0–1.0
  readonly bestPosition: number;
  readonly sectorDeltas: ReadonlyArray<{ sector: number; delta: number }> | null;
  deltaAt(trackPosition: number): number;
  deltaTrace(resolution?: number): Float64Array;
}
