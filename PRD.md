# Racecraft Telemetry SDK — Product Requirements

## Goal

A TypeScript library that parses MoTeC (.ld/.ldx), Pi/Cosworth (.pds), and VBOX (.vbo) telemetry files into a clean, normalized `Lap` object with track-position-based interpolation. Designed for analysis tools, overlays, and visualization — not raw signal processing.

---

## Core Concepts

### LapSample

The public interface for a single point-in-time snapshot. Not a stored object — it's a lightweight view that reads directly from the channel matrix at a sample index. Zero allocation on the hot path.

```typescript
interface LapSample {
  // Time & Position
  readonly time: number;            // seconds from lap start
  readonly distance: number;        // meters from lap start (raw distance channel / speed-integrated)
  readonly trackPosition: number;   // 0.0–1.0 — GPS arc-length when available, distance-based otherwise

  // GPS (WGS84)
  readonly gpsLat: number | null;        // decimal degrees (null if no GPS)
  readonly gpsLon: number | null;        // decimal degrees (null if no GPS)
  readonly gpsAlt: number | null;        // meters ASL
  readonly gpsSpeed: number | null;      // km/h from GPS receiver
  readonly gpsSatellites: number | null; // satellite count — low = noisy position
  readonly gpsFix: number | null;        // fix quality: 0=none, 1=standalone, 2=DGPS, 3=RTK

  // Vehicle
  readonly speed: number;           // km/h (corrected/wheel speed)
  readonly rpm: number | null;      // engine RPM
  readonly gear: number | null;     // 0=N, 1–8, -1=R

  // Driver Inputs — pedal positions (0.0–1.0)
  readonly throttle: number;              // driver's throttle pedal (pre-TC, the "true" input)
  readonly throttleActual: number | null; // post-TC effective throttle
  readonly brakePedal: number | null;          // brake pedal position 0.0–1.0
  readonly brakePressure: number | null;       // front brake pressure in bar
  readonly brakePressureRear: number | null;   // rear brake pressure in bar (for bias analysis)
  readonly clutchPedal: number | null;         // clutch pedal 0.0=engaged, 1.0=disengaged
  readonly clutchActual: number | null;   // clutch actuator position

  // Steering
  readonly steering: number | null; // degrees, + = right

  // Traction Control
  readonly tcActive: boolean;       // derived: throttle - throttleActual > 0.02
  readonly tcCut: number | null;    // TC throttle reduction 0.0–1.0
  readonly tcSlip: number | null;   // TC target slip ratio

  // Dynamics
  readonly gLong: number | null;    // longitudinal G (+ = acceleration)
  readonly gLat: number | null;     // lateral G (+ = right turn)
  readonly heading: number | null;  // GPS heading 0–360 degrees (0=north, 90=east)
  readonly yawRate: number | null;  // deg/s (from sensor, or derived from heading delta)

  // Wheel Speeds (km/h)
  readonly wheelSpeedFL: number | null;
  readonly wheelSpeedFR: number | null;
  readonly wheelSpeedRL: number | null;
  readonly wheelSpeedRR: number | null;

  // Suspension (mm of travel)
  readonly damperFL: number | null;
  readonly damperFR: number | null;
  readonly damperRL: number | null;
  readonly damperRR: number | null;
}
```

### Design Principles for LapSample

1. **`throttle` is always the driver's pedal input** — this is what matters for driver coaching. If a car has no traction control data, `throttle` is the only throttle channel and `throttleActual` is `null`.

2. **`null` means "channel not recorded in this session"**, never zero. Consumers check `lap.has.*` once per lap and never need to null-check per-sample.

3. **Only `time`, `distance`, `trackPosition`, `speed`, and `throttle` are guaranteed non-null.** Everything else can be missing depending on the car/logger. `speed` is the minimum viable signal — without it we can't compute anything useful.

4. **`tcActive` prefers a direct channel** when available (VBO `TC_Active`, MoTeC `tc active`). Falls back to derived: `true` when `throttleActual !== null && throttle - throttleActual > 0.02`. This lets you paint TC interventions on traces without needing a dedicated TC channel.

5. **Brake has three independent channels**: `brakePedal` (0–1 normalized position), `brakePressure` (front bar), and `brakePressureRear` (rear bar). Files typically have one or two of these. Each is null when not recorded. Cars with front+rear pressure enable brake bias analysis: `front / (front + rear)`.

6. **GPS coordinates are always in WGS84 decimal degrees** — radians from PDS files and NMEA/VBOX-minutes from VBO files are auto-converted. `null` when no GPS available (not `0,0` — that's a real coordinate).

7. **`gear` uses `-1` for reverse**, `0` for neutral, `1–8` for forward gears. Null when no gear channel exists.

8. **Wheel speeds are individual**, not averaged. The averaged/corrected speed goes in `speed`. Individual wheel speeds enable slip ratio analysis, differential behavior, and understeer/oversteer detection.

9. **`heading` is GPS-derived** (0–360°, 0=north, clockwise). When a yaw rate sensor isn't available but heading is (common in VBO data at 25Hz), `yawRate` can be derived from `Δheading / Δtime`. The derivation handles the 360→0 wraparound correctly.

10. **`LapSample` is a view, not an object.** It holds a reference to the channel matrix + an index. Property access reads `matrix.channels[ch][idx]` directly. Iterating `lap.samples` yields these views lazily. For hot-path code, `lap.channel('speed')` returns a `Float64Array.subarray()` — zero copy, zero allocation.

---

## Session Class

```typescript
class Session {
  readonly id: string;               // unique identifier (hash of file content)
  readonly fileURL: string;          // source file path/URL
  readonly format: 'motec' | 'pds' | 'vbo';
  readonly driver: string;
  readonly vehicle: string;
  readonly track: string;
  readonly date: Date;
  readonly sampleRate: number;       // Hz of highest-rate channel

  // All laps in session order
  readonly laps: ReadonlyArray<Lap>;
  readonly lapCount: number;

  // Channel availability for this session (same for all laps)
  readonly has: ChannelAvailability;

  // Circuit metadata (from VBO [laptiming] / [circuit details], or external)
  readonly circuit: CircuitInfo | null;

  // Session-level data
  readonly totalDuration: number;    // seconds
  readonly totalDistance: number;     // meters

  constructor(data: SessionData);

  /** Get a specific lap by index (0-based, all laps). Throws if out of range. */
  lap(index: number): Lap;

  /** Get a specific lap by lap number (1-based, flying laps only). */
  lapByNumber(lapNumber: number): Lap | null;

  /** All timed laps: Flying + FirstFlying. Excludes out-laps, in-laps, slow. */
  timedLaps(): Lap[];

  /** The fastest timed lap (lowest lapTime among timedLaps). */
  fastestLap(): Lap | null;

  /** All stints: groups of consecutive timed laps between pit stops. */
  stints(): Stint[];
}

interface Stint {
  readonly stintNumber: number;      // 1-based
  readonly outLap: Lap | null;       // null if session starts on track
  readonly inLap: Lap | null;        // null if session ends on track
  readonly laps: ReadonlyArray<Lap>; // timed laps in this stint
  readonly fastestLap: Lap | null;
}

interface CircuitInfo {
  readonly name: string | null;
  readonly country: string | null;
  /** Start/finish and split lines, if defined. */
  readonly timingLines: ReadonlyArray<TimingLine>;
}

interface TimingLine {
  readonly type: 'start' | 'split';
  readonly name: string;
  readonly start: { lat: number; lon: number };
  readonly end: { lat: number; lon: number };
}
```

---

## Lap Classification

Every lap gets a `kind` from the `LapKind` enum. This drives filtering, numbering, and display logic:

```typescript
enum LapKind {
  /** Car leaving pit lane — speed ramps up, often crosses pit exit line. Excluded from timing. */
  OutLap = 'out-lap',

  /** Car entering pit lane — speed drops off, crosses pit entry line. Excluded from timing. */
  InLap = 'in-lap',

  /** Full flying lap — crossed S/F at speed on both ends. Eligible for timing and comparison. */
  Flying = 'flying',

  /** First timed lap of a stint — crossed S/F at the end but started from pit exit.
   *  May be valid for timing but often compromised by cold tires / traffic. */
  FirstFlying = 'first-flying',

  /** Lap where car was stationary for extended time (formation lap, red flag, stall). */
  Slow = 'slow',
}
```

### Classification logic

Detection runs after lap boundaries are established (from beacons, GPS S/F crossing, or lap number channel):

```typescript
function classifyLap(
  lap: { startIdx: number; endIdx: number },
  matrix: ChannelMatrix,
  prevLap: { kind: LapKind } | null,
  nextLap: { startIdx: number; endIdx: number } | null,
  pitSpeedThreshold: number = 60,  // km/h — below this in pit lane
): LapKind {
  const speed = matrix.channels[3]; // speed row
  const n = lap.endIdx - lap.startIdx;

  // Median lap time for this session (pre-computed) for "slow" detection
  const lapDuration = (lap.endIdx - lap.startIdx) / matrix.sampleRate;

  // Sample speed at start and end of lap (avg over ~1s to avoid noise)
  const windowSize = Math.min(matrix.sampleRate, Math.floor(n / 4));
  let startSpeedSum = 0, endSpeedSum = 0;
  for (let i = 0; i < windowSize; i++) {
    startSpeedSum += speed[lap.startIdx + i];
    endSpeedSum += speed[lap.endIdx - 1 - i];
  }
  const startSpeed = startSpeedSum / windowSize;
  const endSpeed = endSpeedSum / windowSize;

  // Car on jack (VBO-specific) — if present and active during lap, it's pit time
  const carOnJack = matrix.row('carOnJack');
  if (carOnJack) {
    let jackSamples = 0;
    for (let i = lap.startIdx; i < lap.endIdx; i++) {
      if (carOnJack[i] > 0.5) jackSamples++;
    }
    if (jackSamples > n * 0.1) {
      // This lap contains significant pit time
      return LapKind.InLap;  // or the next lap is OutLap — handled below
    }
  }

  // Min speed during the lap
  let minSpeed = Infinity;
  for (let i = lap.startIdx; i < lap.endIdx; i++) {
    if (speed[i] < minSpeed) minSpeed = speed[i];
  }

  // Out-lap: starts slow (below pit threshold), ends at racing speed
  if (startSpeed < pitSpeedThreshold && endSpeed > pitSpeedThreshold) {
    return LapKind.OutLap;
  }

  // In-lap: starts at racing speed, ends slow
  if (startSpeed > pitSpeedThreshold && endSpeed < pitSpeedThreshold) {
    return LapKind.InLap;
  }

  // Slow lap: very slow min speed or way longer than median
  if (minSpeed < 10 && lapDuration > 30) {
    return LapKind.Slow;
  }

  // First flying: previous lap was an out-lap
  if (prevLap?.kind === LapKind.OutLap) {
    return LapKind.FirstFlying;
  }

  return LapKind.Flying;
}
```

### Lap numbering

`lapNumber` counts only **flying laps** (including `FirstFlying`), starting from 1. Out-laps, in-laps, and slow laps don't get a lap number — they use display labels instead:

| Kind | `lapNumber` | `displayLabel` | Example |
|---|---|---|---|
| `OutLap` | `null` | `"OUT"` | Leaving pits |
| `FirstFlying` | `1` | `"L1"` | First timed lap |
| `Flying` | `2`, `3`, ... | `"L2"`, `"L3"`, ... | Normal laps |
| `InLap` | `null` | `"IN"` | Entering pits |
| `Slow` | `null` | `"SLOW"` | Formation, red flag |

This means `session.timedLaps()` returns only `Flying` + `FirstFlying` laps, `session.fastestLap()` only considers those, and lap comparison only makes sense between them.

---

## Lap Class

```typescript
class Lap {
  // Identity
  readonly session: Session;
  readonly lapIndex: number;         // 0-based position in session.laps (all laps including out/in)
  readonly lapNumber: number | null; // 1-based, flying laps only. null for out-lap/in-lap/slow.
  readonly displayLabel: string;     // "OUT", "L1", "L2", "IN", "SLOW"

  // Classification
  readonly kind: LapKind;

  // Timing
  readonly lapTime: number;          // milliseconds
  readonly startTime: number;        // seconds from session start
  readonly endTime: number;          // seconds from session start
  readonly sampleRate: number;       // Hz of internal data
  readonly sampleCount: number;
  readonly totalDistance: number;     // meters (GPS arc-length if available, else raw distance)

  // Sector times (null if no sector definitions)
  readonly sectors: ReadonlyArray<SectorTime> | null;

  // All samples as a slice — zero-copy view into the channel matrix.
  // Iterate with `for (const s of lap.samples)` or index with `lap.samples.at(i)`.
  readonly samples: LapSampleSlice;

  // Channel availability (check once, not per-sample)
  readonly has: ChannelAvailability;

  constructor(options: {
    session: Session;
    lapIndex: number;
    minHz?: number;        // minimum required sample rate (default: 10)
    targetHz?: number;     // desired output rate (default: source rate, capped at 100)
    requireGps?: boolean;  // fail if no GPS data (default: false)
  });
  // Throws LapError if:
  //   - source sample rate < minHz
  //   - requireGps is true but no GPS channels exist
  //   - lap has zero duration

  // ── Track Position ─────────────────────────────────────────
  //
  // trackPosition (0.0–1.0) is the PRIMARY spatial coordinate.
  //
  // When GPS is available (from telemetry channels OR video GPS):
  //   trackPosition is computed from cumulative GPS arc length,
  //   with quality filtering (see "GPS Quality" section).
  //   This is ground-truth — immune to wheel slip, sensor drift,
  //   and distance channel resets.
  //
  // When GPS is NOT available:
  //   Falls back to the distance channel (or integrated speed).
  //   Less accurate but still usable.
  //
  // The `positionSource` field tells you which was used.

  readonly positionSource: 'gps' | 'distance' | 'speed-integrated';

  // ── Track Position Queries ────────────────────────────────

  /**
   * Get interpolated sample at a track position (0.0–1.0).
   * Uses speed-aware interpolation (see "Speed-Aware Interpolation").
   */
  at(trackPosition: number): LapSample;

  /**
   * Get N evenly-spaced samples across the lap by track position.
   * Returns exactly `count` samples from 0.0 to 1.0 inclusive.
   */
  resample(count: number): LapSample[];

  /**
   * Get all original-rate samples within a track position range (0.0–1.0).
   * Returns a LapSampleSlice — a zero-copy range view into the matrix.
   */
  slice(fromPosition: number, toPosition: number): LapSampleSlice;

  /**
   * Get a single channel as a Float64Array for this lap.
   * Returns a subarray view into the matrix — zero copy.
   * Returns null if the channel doesn't exist.
   *
   * @param name - Channel name (e.g. 'speed', 'throttle', 'gLong')
   */
  channel(name: string): Float64Array | null;

  /**
   * Get a single channel resampled to N evenly-spaced track positions.
   * Returns a new Float64Array of length `resolution`.
   * NaN for unavailable channels.
   *
   * @param name - Channel name
   * @param resolution - Number of points (default: 1000)
   */
  channelAtPositions(name: string, resolution?: number): Float64Array;

  // ── Distance Queries (raw, non-GPS) ──────────────────────

  /** Sample at cumulative distance (meters from lap start). Uses raw distance, not GPS. */
  atByDistance(meters: number): LapSample;

  /** Slice by raw distance range (meters). Uses raw distance, not GPS. */
  sliceByDistance(fromMeters: number, toMeters: number): LapSampleSlice;

  // ── Time Queries ──────────────────────────────────────────

  /** Sample at elapsed time (seconds from lap start). */
  atTime(seconds: number): LapSample;

  // ── GPS Helpers ───────────────────────────────────────────

  /** GPS trace as [lat, lon] pairs, one per sample. Null if no GPS. */
  gpsTrace(): [number, number][] | null;

  /** GPS bounding box. Null if no GPS. */
  gpsBounds(): { north: number; south: number; east: number; west: number } | null;

  /** Find track position nearest to a GPS coordinate. Throws if no GPS. */
  nearestPosition(lat: number, lon: number): number;

  // ── Comparison ────────────────────────────────────────────

  /**
   * Compare this lap against another, producing a time delta at each track position.
   * Positive delta = this lap is slower at that point.
   * Both laps must be from the same track (or forceCompare must be true).
   */
  delta(other: Lap, options?: { resolution?: number; forceCompare?: boolean }): LapDelta;

  // ── Serialization ─────────────────────────────────────────

  /** Serialize to a plain object (for JSON, caching, web workers). */
  toJSON(): LapJSON;

  /** Reconstruct from serialized form. */
  static fromJSON(data: LapJSON): Lap;
}

interface SectorTime {
  readonly sector: number;           // 1-indexed
  readonly name: string;             // "S1", "S2", or custom name from timing lines
  readonly time: number;             // milliseconds
  readonly startPosition: number;    // 0.0–1.0 track position
  readonly endPosition: number;      // 0.0–1.0 track position
}

interface ChannelAvailability {
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
}
```

---

## LapDelta (Comparison)

```typescript
interface LapDelta {
  /** This lap (the "subject"). */
  readonly lap: Lap;
  /** The reference lap being compared against. */
  readonly reference: Lap;

  /** Time delta at a track position. Positive = this lap is slower. */
  deltaAt(trackPosition: number): number;

  /** Time delta as Float64Array at uniform track positions. */
  deltaTrace(resolution?: number): Float64Array;

  /** Total time difference (lap.lapTime - reference.lapTime) in ms. */
  readonly totalDelta: number;

  /** Track position where this lap loses the most time (biggest positive delta). */
  readonly worstPosition: number;

  /** Track position where this lap gains the most time (biggest negative delta). */
  readonly bestPosition: number;

  /** Per-sector deltas (null if no sectors defined). */
  readonly sectorDeltas: ReadonlyArray<{ sector: number; delta: number }> | null;
}
```

The delta is computed by integrating time differences along the track. At each track position, we know the elapsed time for both laps (from the time channel interpolated at that position). The delta is: `thisLap.atTime(pos).time - referenceLap.atTime(pos).time`, normalized so the start is 0.

---

## Track-Position Interpolation Strategy

### Position source priority

Track position is a **physical location on the circuit**, expressed as 0.0–1.0 (fraction of total lap length). The source is chosen automatically:

1. **GPS arc length** (preferred) — When GPS coordinates are available from any source (telemetry `gps_lat`/`gps_lon`, GoPro GPMF, VBO GPS), compute cumulative haversine arc length between consecutive GPS samples. This is ground-truth geometry — it doesn't suffer from wheel spin, ABS pulses, or distance channel resets.

2. **Distance channel** (fallback) — When GPS is unavailable, use the telemetry distance channel (`lap distance corrected`, `lap distance`, etc.). Reasonably accurate but can drift with wheel slip.

3. **Speed integration** (last resort) — If no distance channel exists, integrate the speed channel over time. Least accurate due to cumulative integration error.

### GPS quality filtering

Raw GPS data has noise that can corrupt arc-length computation. Before computing arc length, apply these filters:

```typescript
function filterGPSForArcLength(
  gpsLat: number[], gpsLon: number[],
  speed: number[],        // from telemetry speed channel (more reliable than GPS speed)
  sampleRate: number,
  satellites?: number[],  // gpsSatellites channel (from VBO, or MoTeC/PDS if logged)
  fix?: number[],         // gpsFix channel (solution quality)
): { lat: number[]; lon: number[]; valid: boolean[] } {
  const valid = new Array(gpsLat.length).fill(true);

  for (let i = 1; i < gpsLat.length; i++) {
    const dt = 1 / sampleRate;
    const gpsDist = haversine(gpsLat[i-1], gpsLon[i-1], gpsLat[i], gpsLon[i]);
    const expectedDist = (speed[i] / 3.6) * dt;  // speed in km/h → m/s

    // 0. Satellite/fix quality: if available, reject low-quality fixes.
    //    VBOX solution_type: 0=no fix, 1=standalone, 2=DGPS, 3=RTK.
    //    < 4 satellites = unreliable.
    if (satellites && satellites[i] < 4) {
      valid[i] = false;
      continue;
    }
    if (fix && fix[i] === 0) {
      valid[i] = false;
      continue;
    }

    // 1. Speed sanity: if GPS says the car jumped 50m but speed says 2m,
    //    the GPS sample is garbage (multipath, tunnel exit, etc.)
    if (expectedDist > 0.5 && gpsDist > expectedDist * 3) {
      valid[i] = false;
      continue;
    }

    // 2. Stationary jitter: below 5 km/h, GPS wanders ±2m randomly.
    //    Don't accumulate arc length from noise.
    if (speed[i] < 5 && gpsDist < 3) {
      valid[i] = false;
      continue;
    }

    // 3. Teleportation: reject individual jumps > 100m (clearly invalid)
    if (gpsDist > 100) {
      valid[i] = false;
      continue;
    }
  }

  return { lat: gpsLat, lon: gpsLon, valid };
}
```

When a GPS sample is marked invalid, the arc-length increment for that interval is filled from the distance channel (or speed integration) instead. This gives us GPS-quality positioning through good sections while surviving bad GPS gracefully.

### GPS arc length computation

```typescript
// After filtering, build cumulative arc length
const arcLengths = [0];
for (let i = 1; i < lat.length; i++) {
  let increment: number;
  if (valid[i] && valid[i-1]) {
    increment = haversine(lat[i-1], lon[i-1], lat[i], lon[i]);
  } else {
    // Fall back to speed integration for this interval
    increment = (speed[i] / 3.6) * (1 / sampleRate);
  }
  arcLengths[i] = arcLengths[i - 1] + increment;
}

const totalArc = arcLengths[arcLengths.length - 1];
const trackPosition = arcLengths.map(d => d / totalArc);  // 0.0–1.0
```

GPS positions may be at a lower sample rate than other channels (e.g. 10Hz GPS vs 50Hz telemetry). The arc-length curve is interpolated to the full sample rate before deriving `trackPosition`.

### GPS jitter smoothing

Even after rejecting bad samples, GPS coordinates have noise — typically ±0.5m for RTK, ±2m for standalone. This matters for `gpsTrace()` (map overlays look wobbly) and `nearestPosition()` (wrong point if GPS is noisy).

The GPS lat/lon stored in the channel matrix are **smoothed** on parse. The raw coordinates are filtered, then the smoothed versions replace them:

```typescript
function smoothGPS(
  lat: Float64Array, lon: Float64Array,
  speed: Float64Array,
  valid: boolean[],          // from filterGPSForArcLength
  sampleRate: number,
  satellites?: Float64Array | null,  // gpsSatellites channel — widens kernel when low
): void {
  // Adaptive Gaussian kernel: wider at high speed (straight, GPS noise dominant),
  // narrower at low speed (tight corners, must preserve geometry).
  // Also widens when satellite count is low (worse fix = more noise to smooth).
  //
  // At 200 km/h on a straight, ±5 samples (±0.1s at 50Hz) = ±5.5m window.
  // At 50 km/h in a hairpin, ±2 samples (±0.04s) = ±0.55m window.
  // This prevents smoothing from "cutting" corners while still removing jitter on straights.

  const smoothed_lat = new Float64Array(lat.length);
  const smoothed_lon = new Float64Array(lon.length);

  for (let i = 0; i < lat.length; i++) {
    if (!valid[i]) {
      // Invalid samples: interpolate from nearest valid neighbors
      smoothed_lat[i] = lat[i]; // will be patched in second pass
      smoothed_lon[i] = lon[i];
      continue;
    }

    // Kernel half-width scales with speed: more smoothing at high speed.
    // Also increases when satellite count is low (noisier fix needs more smoothing).
    const speedKmh = speed[i];
    const satBoost = (satellites && satellites[i] < 8) ? 2 : 0; // widen kernel for weak fix
    const halfWidth = Math.max(1, Math.min(10,
      Math.round(1 + (speedKmh / 50) + satBoost)
    ));

    let sumLat = 0, sumLon = 0, sumW = 0;
    for (let j = -halfWidth; j <= halfWidth; j++) {
      const k = i + j;
      if (k < 0 || k >= lat.length || !valid[k]) continue;
      const w = Math.exp(-(j * j) / (2 * (halfWidth / 2) ** 2)); // Gaussian
      sumLat += lat[k] * w;
      sumLon += lon[k] * w;
      sumW += w;
    }
    smoothed_lat[i] = sumW > 0 ? sumLat / sumW : lat[i];
    smoothed_lon[i] = sumW > 0 ? sumLon / sumW : lon[i];
  }

  // Patch invalid samples by linear interpolation between valid neighbors
  let lastValid = -1;
  for (let i = 0; i < lat.length; i++) {
    if (valid[i]) {
      if (lastValid >= 0 && i - lastValid > 1) {
        // Fill gap between lastValid and i
        for (let j = lastValid + 1; j < i; j++) {
          const t = (j - lastValid) / (i - lastValid);
          smoothed_lat[j] = smoothed_lat[lastValid] + t * (smoothed_lat[i] - smoothed_lat[lastValid]);
          smoothed_lon[j] = smoothed_lon[lastValid] + t * (smoothed_lon[i] - smoothed_lon[lastValid]);
        }
      }
      lastValid = i;
    }
  }

  // Write back to matrix
  lat.set(smoothed_lat);
  lon.set(smoothed_lon);
}
```

**Key design choice:** smoothing is speed-adaptive. A fixed-width filter would either leave jitter on straights (too narrow) or cut corners on tight turns (too wide). By scaling the Gaussian kernel with speed, we get the best of both: clean GPS traces on straights while preserving the true racing line through corners.

The smoothed coordinates are what `gpsTrace()`, `nearestPosition()`, and the map overlay see. Arc-length computation uses the smoothed coordinates too (after filtering) — the smoothing slightly reduces total arc length but the effect is <0.1% and doesn't affect track position accuracy.

### Low-rate GPS and corner cutting

When GPS is at 1–5Hz, straight-line haversine between samples "cuts corners" through tight turns — the chord is shorter than the arc. This systematically underestimates distance through corners. The hybrid approach above mitigates this: in the tight part of a hairpin, the GPS jumps are flagged by the speed-sanity check and replaced with speed-integrated distance, which correctly measures the actual path length.

### Why GPS > distance

| Problem | Distance channel | GPS arc length |
|---|---|---|
| Wheel lockup under braking | Over-counts (wheels stop, car slides) | ✅ Correct |
| Wheel spin on exit | Over-counts (wheels spin, car barely moves) | ✅ Correct |
| Sensor reset mid-lap | Distance jumps to 0 | ✅ Unaffected |
| ABS pulsing | Noisy distance increments | ✅ Smooth |
| Off-track excursion | Counts same as on-track | ✅ Measures actual path |

### Interpolating at a query position

```typescript
function at(queryPosition: number): LapSample {
  // Clamp to valid range
  const pos = Math.max(0, Math.min(1, queryPosition));

  // Binary search for bracketing samples
  const [lo, hi] = findBracket(this.trackPositions, pos);

  // Raw linear fraction between the two samples
  const span = this.trackPositions[hi] - this.trackPositions[lo];
  const rawFraction = span > 0 ? (pos - this.trackPositions[lo]) / span : 0;

  // Apply speed-aware bias (speed is always row 3)
  const t = lerpWithSpeedBias(lo, hi, this.matrix, rawFraction);

  // Lerp every channel, return a LapSample at the interpolated position
  return lerpSample(this.matrix, lo, hi, t);
}
```

### Speed-aware interpolation

When interpolating between two samples, naive linear lerp can be misleading in zones where speed is changing rapidly (e.g. hard braking). A car at 280 km/h covers 78m in one sample interval (at 50Hz) — but at the next sample it might be at 240 km/h covering only 67m. Linear lerp would distribute values evenly across that position span, when in reality the car spent more time (and more physical action) in the later, slower part.

To account for this, interpolation uses an **exponential moving average of speed** to weight the fraction:

```typescript
function lerpWithSpeedBias(
  lo: number, hi: number,
  matrix: ChannelMatrix,
  rawFraction: number,   // naive linear 0–1 between lo and hi
  alpha: number = 0.7,   // EMA decay — higher = more weight on recent sample
): number {
  const speed = matrix.channels[3]; // speed is always row 3

  // Build speed EMA looking back a few samples from `lo`
  // The last sample's speed matters most — it tells you what the car
  // is actually doing RIGHT NOW at the interpolation point.
  const lookback = 4;
  let ema = speed[Math.max(0, lo - lookback)];
  for (let i = Math.max(0, lo - lookback + 1); i <= lo; i++) {
    ema = alpha * speed[i] + (1 - alpha) * ema;
  }
  const speedLo = ema;

  // EMA at hi
  ema = speedLo;
  for (let i = lo + 1; i <= hi; i++) {
    ema = alpha * speed[i] + (1 - alpha) * ema;
  }
  const speedHi = ema;

  // Stationary guard
  if (speedLo + speedHi < 1e-6) return rawFraction;

  // Weight by inverse speed: slower = more "time density" at that point
  // Integral of 1/v over the interval, approximated as weighted blend
  const wLo = 1 / Math.max(speedLo, 1);
  const wHi = 1 / Math.max(speedHi, 1);
  const biased = rawFraction * wHi / (wLo + rawFraction * (wHi - wLo));

  return biased;
}
```

The EMA with `alpha=0.7` means the most recent speed sample contributes ~70% of the weight, the one before ~21%, then ~6%, ~2%. This captures the immediate dynamics (am I on the brakes right now?) without being twitchy from single-sample noise. The result: interpolated values in a braking zone lean toward the end-of-braking state, which better represents the physical reality at that track position.

### Distance queries bypass GPS

`atByDistance()` and `sliceByDistance()` always use the raw distance channel (or speed-integrated distance), never GPS arc length. This is useful when you need to match against distance-based references (e.g. brake markers at "200m board") or when GPS is noisy but the distance channel is trustworthy.

---

## Internal Storage: Channel Matrix

All channel data lives in a single flat matrix: `channels[channelNum][sampleNum]`. A name→number mapping connects the human-readable names to row indices. Everything else — `LapSample`, `LapSampleSlice`, interpolated queries — is a zero-allocation view into this matrix.

```typescript
/**
 * The core data structure. One per session, shared by all laps.
 * Laps are just (startIndex, endIndex) ranges into the same matrix.
 */
class ChannelMatrix {
  /** channels[ch][i] = value of channel `ch` at sample `i`. All at constant Hz. */
  readonly channels: Float64Array[];  // channels[channelNum][sampleNum]
  readonly sampleCount: number;
  readonly sampleRate: number;        // Hz — constant across all channels

  /** Map from channel name → row index in the matrix. */
  readonly nameToIndex: ReadonlyMap<string, number>;

  /** Inverse: index → name. */
  readonly indexToName: readonly string[];

  /** Which channels are present (not all rows may be populated). */
  has(name: string): boolean { return this.nameToIndex.has(name); }

  /** Get a raw row. Returns the Float64Array directly — no copy. */
  row(name: string): Float64Array | null {
    const idx = this.nameToIndex.get(name);
    return idx !== undefined ? this.channels[idx] : null;
  }
}
```

### Well-known channel indices

The first 5 rows are always allocated and always populated (they're required for a valid session):

| Index | Name | Notes |
|---|---|---|
| 0 | `time` | Seconds from session start |
| 1 | `distance` | Meters (raw distance channel or speed-integrated) |
| 2 | `trackPosition` | 0.0–1.0 (computed after GPS filtering) |
| 3 | `speed` | km/h (normalized) |
| 4 | `throttle` | 0.0–1.0 (driver pedal) |

All other channels are optional and appended during parsing. Their index depends on what the file contains — always look up by name, never hard-code indices beyond the first 5.

### LapSample — a view, not an object

`LapSample` is a lightweight accessor that reads directly from the matrix at a given sample index. No field copying, no object allocation on the hot path:

```typescript
class LapSample {
  /** @internal */
  constructor(
    private readonly matrix: ChannelMatrix,
    private readonly idx: number,  // sample index into the matrix
  ) {}

  // Required channels — direct array access, no branching
  get time(): number          { return this.matrix.channels[0][this.idx]; }
  get distance(): number      { return this.matrix.channels[1][this.idx]; }
  get trackPosition(): number { return this.matrix.channels[2][this.idx]; }
  get speed(): number         { return this.matrix.channels[3][this.idx]; }
  get throttle(): number      { return this.matrix.channels[4][this.idx]; }

  // Optional channels — null if channel doesn't exist in this session
  get rpm(): number | null {
    const row = this.matrix.row('rpm');
    return row ? row[this.idx] : null;
  }
  get gpsLat(): number | null {
    const row = this.matrix.row('gpsLat');
    return row ? row[this.idx] : null;
  }
  // ... same pattern for all optional channels

  // Derived
  get tcActive(): boolean {
    const actual = this.throttleActual;
    return actual !== null && this.throttle - actual > 0.02;
  }
}
```

In practice the `row()` lookup is a single `Map.get` — the Map is tiny (≤30 entries) and stays hot in cache. The sample index is just an integer offset into the Float64Array, which is a single pointer dereference.

### LapSampleSlice — a range view

When you call `lap.slice(0.15, 0.22)`, you don't get a copied array of sample objects. You get a `LapSampleSlice` — a start/end range into the same matrix:

```typescript
class LapSampleSlice implements Iterable<LapSample> {
  constructor(
    private readonly matrix: ChannelMatrix,
    readonly startIdx: number,   // first sample index (inclusive)
    readonly endIdx: number,     // last sample index (exclusive)
  ) {}

  get length(): number { return this.endIdx - this.startIdx; }

  /** Access by offset within the slice. */
  at(offset: number): LapSample {
    return new LapSample(this.matrix, this.startIdx + offset);
  }

  /** Iterate — creates LapSample wrappers on demand. */
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
```

### Lap — a range + metadata

A `Lap` is fundamentally just a range `[startIdx, endIdx)` into the session's `ChannelMatrix`, plus computed metadata (lap time, track position mapping, sectors):

```typescript
class Lap {
  /** @internal */
  readonly matrix: ChannelMatrix;
  readonly startIdx: number;  // first sample of this lap in the matrix
  readonly endIdx: number;    // one past last sample

  get sampleCount(): number { return this.endIdx - this.startIdx; }
  get samples(): LapSampleSlice {
    return new LapSampleSlice(this.matrix, this.startIdx, this.endIdx);
  }

  /** Raw channel data for this lap — subarray view, zero copy. */
  channel(name: string): Float64Array | null {
    const row = this.matrix.row(name);
    return row ? row.subarray(this.startIdx, this.endIdx) : null;
  }

  // ... at(), slice(), atTime(), etc. all work via indices into the matrix
}
```

### Why a matrix?

| Property | Named typed arrays | Channel matrix |
|---|---|---|
| Adding a new channel | Change interface + all constructors | Just append a row |
| Memory layout | Scattered allocations | Contiguous per-channel (cache-friendly) |
| Lap = slice of session | Copy sub-ranges into new arrays | Just two integers (startIdx, endIdx) |
| `LapSample` at index `i` | Read N named fields | Read `channels[ch][i]` for each `ch` |
| `lap.channel('speed')` | Return named field | `row.subarray(start, end)` — zero copy |
| `lap.slice(0.15, 0.22)` | Copy into new arrays | Two integers → `LapSampleSlice` |
| Worker transfer | Ship N named buffers | Ship one `Float64Array[]` + one name map |
| Unknown/custom channels | Impossible without schema change | Just more rows — consumer looks up by name |

The matrix approach also means **custom channels pass through automatically**. If a MoTeC file has `Warp Drive Temp` or a VBO has `Fuel_Probe`, they land in the matrix with their normalized name and are accessible via `lap.channel('warpDriveTemp')` — no schema change needed. The `LapSample` interface only exposes the well-known channels with typed getters, but the matrix holds everything.

### Resampling to constant Hz

Source files have channels at different rates (e.g., GPS at 10Hz, speed at 100Hz, dampers at 200Hz). On parse, all channels are resampled to a single constant sample rate (the `targetHz` from constructor options, default = source max capped at 100Hz). This is what makes the matrix rectangular — every row has the same length.

Resampling uses linear interpolation for continuous channels and nearest-neighbor for discrete channels (gear, lap number). The `sampleRate` field on the matrix tells you the constant Hz.

---

## Channel Mapping (Source → Normalized)

Channel names differ wildly between loggers. The parser normalizes by matching against known aliases (case-insensitive, punctuation-stripped). First match wins.

### Engine / RPM

| Concept | MoTeC .ld aliases | Pi .pds aliases | VBO aliases |
|---|---|---|---|
| **rpm** | `engine rpm`, `rpm`, `eng rpm`, `n_engine` | `Engine Speed`, `RPM`, `N_Engine`, `Eng_N` | `Engine_Speed` |

### Throttle (driver = primary)

| Concept | Aliases |
|---|---|
| **throttle** (driver pedal) | `driver throttle pos`, `fbwdrivertps`, `pps`, `accel pedal pos`, `acc pedal pos`, `Throttle_Pedal` |
| **throttleActual** (post-TC) | `throttle pos`, `tps`, `tpsreal`, `aps` |

If only one throttle channel exists, it becomes `throttle` (assumed = driver input). If only a post-TC channel is found and no driver channel, it still maps to `throttle` — better to have approximate driver input than nothing.

### Brake

| Concept | Aliases |
|---|---|
| **brakePedal** | `brake pos`, `brake pedal pos`, `brake pedal` |
| **brakePressure** | `brake pressure f`, `brake pressure fr`, `p_f_brake`, `Brake_Pressure_Front` |
| **brakePressureRear** | `brake pressure r`, `brake pressure rr`, `p_r_brake`, `Brake_Pressure_Rear` |

Note: `brakePressure` is the **front** brake pressure (or the only pressure sensor). `brakePressureRear` is available on cars with dual-circuit brake pressure sensing — useful for brake bias analysis.

### Clutch

| Concept | Aliases |
|---|---|
| **clutchPedal** | `clutch pos`, `clutch position`, `clutch pedal`, `clutch` |
| **clutchActual** | `clutch actuator`, `clutch act pos` |

### Traction Control (direct flags)

| Concept | Aliases | Notes |
|---|---|---|
| **tcActive** (direct) | `tc_active`, `TC_Active`, `tc active` | Boolean 0/1. Preferred over derived. |
| **tcCut** | `tc throttle cut`, `tc_cut`, `tccut`, `tc throttle reduction` | |
| **tcSlip** | `tc slip target`, `tc_slip`, `tcslip`, `TC_Slip` | |

### Dynamics

| Concept | Aliases | Notes |
|---|---|---|
| **gLong** | `g force long`, `i_accel_long`, `fia_accelx`, `ComboAcc` | `ComboAcc` in VBO = longitudinal acceleration |
| **gLat** | `g force lat`, `i_accel_lat`, `fia_accely`, `Combo_G` | `Combo_G` in VBO = lateral G |
| **heading** | `heading`, `gps heading`, `fia_gpsheading` | 0–360° |
| **yawRate** | `yaw rate`, `yaw velocity`, `gyro_z` | If absent, derive from heading Δ |

### GPS

| Concept | Aliases | Notes |
|---|---|---|
| **gpsLat** | `fia_gpslatn`, `gps latitude`, `latitude` | rad→deg, NMEA→deg auto-convert |
| **gpsLon** | `fia_gpslonge`, `gps longitude`, `longitude` | rad→deg, NMEA→deg auto-convert |
| **gpsAlt** | `gps altitude`, `fia_gpsalt`, `gps_alt`, `height` | meters ASL |
| **gpsSpeed** | `fia_gpsvel`, `gps speed`, `velocity` | km/h |
| **gpsSatellites** | `satellites`, `sats`, `gps_sats`, `gps_satellites` | Satellite count per sample |
| **gpsFix** | `solution type`, `solution_type`, `fix_type`, `gps_fix` | 0=none, 1=standalone, 2=DGPS, 3=RTK |

### Speed / Position

| Concept | Aliases |
|---|---|
| **speed** | `corr speed`, `ground speed`, `wheel speed avg`, `speed`, `Vehicle_Speed` |
| **gear** | `gear_pos`, `gear`, `gearposdisplay`, `Gear` |
| **distance** | `lap distance corrected`, `lap distance`, `distance_wspd_app` |
| **steering** | `steering angle`, `steer`, `Steering_Angle` |

### Wheel Speeds

| Concept | Aliases |
|---|---|
| **wheelSpeedFL** | `wheel speed fl`, `wspd_fl`, `v_fl_wheel`, `whl_spd_fl`, `wheel_speed_lf`, `front left wheel speed` |
| **wheelSpeedFR** | `wheel speed fr`, `wspd_fr`, `v_fr_wheel`, `whl_spd_fr`, `wheel_speed_rf`, `front right wheel speed` |
| **wheelSpeedRL** | `wheel speed rl`, `wspd_rl`, `v_rl_wheel`, `whl_spd_rl`, `wheel_speed_lr`, `rear left wheel speed` |
| **wheelSpeedRR** | `wheel speed rr`, `wspd_rr`, `v_rr_wheel`, `whl_spd_rr`, `wheel_speed_rr`, `rear right wheel speed` |

### Suspension

| Concept | Aliases |
|---|---|
| **damperFL** | `x_fl_damper`, `damper travel fl` |
| **damperFR** | `x_fr_damper`, `damper travel fr` |
| **damperRL** | `x_rl_damper`, `damper travel rl` |
| **damperRR** | `x_rr_damper`, `damper travel rr` |

### Pit / Session Metadata (internal, not on LapSample)

| Concept | Aliases | Notes |
|---|---|---|
| **carOnJack** | `car_on_jack`, `Car_On_Jack`, `pit_limiter` | Boolean 0/1. Feeds LapKind classification. |
| **lapNumber** | `lap_number`, `Lap_Number`, `lap number` | Used for lap boundary detection, not display. |
| **lapGainLoss** | `lap_gain_loss`, `Lap_Gain_Loss` | Live delta from ECU. Informational. |

---

## Unit Normalization Rules

All units are normalized on parse — consumers never deal with raw units.

| Field | Normalized Unit | Conversions |
|---|---|---|
| speed, gpsSpeed, wheelSpeed* | km/h | m/s × 3.6, mph × 1.609, knots × 1.852 |
| throttle, brakePedal, clutchPedal | 0.0–1.0 | % ÷ 100, rad ÷ 1.745, deg ÷ 100 |
| brakePressure | bar | psi × 0.0689, kPa × 0.01 |
| steering | degrees | rad × 180/π |
| gpsLat, gpsLon | decimal degrees | rad × 180/π, NMEA DDMM.MMM → DD.DDD, VBOX minutes ÷ 60 |
| gpsAlt | meters | feet × 0.3048 |
| rpm | RPM | — |
| damper* | mm | — |
| gLong, gLat | G | m/s² ÷ 9.81 |
| heading | degrees (0–360) | — (already in degrees from all sources) |
| yawRate | deg/s | rad/s × 180/π |
| brakePressureRear | bar | psi × 0.0689, kPa × 0.01 |
| distance | meters | km × 1000, miles × 1609 |
| time | seconds | — |

---

## Constructor Behavior

```typescript
const session = await parseFile('race.ld');  // or .pds, .vbo
const lap = session.lap(2);  // 0-indexed

// Or with options:
const lap = new Lap({
  session,
  lapIndex: 2,
  minHz: 20,          // fail if source < 20Hz
  targetHz: 50,       // resample to 50Hz internally
  requireGps: true,   // fail if no GPS channels
});
```

### Failure modes (throws `LapError`)

| Condition | Error |
|---|---|
| Source rate < `minHz` | `"Source sample rate (10Hz) below minimum (20Hz)"` |
| `requireGps` but no GPS | `"GPS channels required but not available"` |
| Zero duration | `"Lap has zero duration"` |

Note: zero distance is **not** a failure — a standing-start formation lap may begin stationary. The first few samples will cluster at `trackPosition ≈ 0` until the car moves.

### Defaults

- `minHz`: `10` — anything below 10Hz is too coarse for corner analysis
- `targetHz`: source rate, capped at `100` — no point storing > 100Hz for visualization
- `requireGps`: `false`

---

## Usage Examples

### Compare braking points between two laps

```typescript
const session = await parseFile('race.ld');
const fast = session.lap(3);
const slow = session.lap(5);

// Get brake traces aligned by track position (resampled to 1000 uniform points)
const fastBrake = fast.channelAtPositions('brakePressure', 1000);
const slowBrake = slow.channelAtPositions('brakePressure', 1000);

// Find where fast lap brakes later
for (let i = 0; i < 1000; i++) {
  const pos = i / 1000;
  if (slowBrake[i] > 5 && fastBrake[i] < 5) {
    console.log(`At ${(pos * 100).toFixed(1)}% — slow lap braking, fast lap still off`);
  }
}
```

### Time delta between laps

```typescript
const fast = session.fastestLap()!;
const mine = session.lap(4);

const delta = mine.delta(fast);
console.log(`Total: ${delta.totalDelta > 0 ? '+' : ''}${(delta.totalDelta / 1000).toFixed(3)}s`);
console.log(`Worst section: ${(delta.worstPosition * 100).toFixed(0)}% of track`);
console.log(`Best section: ${(delta.bestPosition * 100).toFixed(0)}% of track`);

if (delta.sectorDeltas) {
  for (const s of delta.sectorDeltas) {
    console.log(`S${s.sector}: ${s.delta > 0 ? '+' : ''}${(s.delta / 1000).toFixed(3)}s`);
  }
}
```

### Extract corner data with GPS

```typescript
const lap = new Lap({ session, lapIndex: 2, requireGps: true });

// Turn 1 is roughly 15%–22% of the track
const turn1 = lap.slice(0.15, 0.22);

for (const s of turn1) {
  console.log(
    `${(s.trackPosition * 100).toFixed(1)}% | ` +
    `${s.speed.toFixed(0)} km/h | ` +
    `brake: ${(s.brakePressure ?? 0).toFixed(0)} bar | ` +
    `throttle: ${(s.throttle * 100).toFixed(0)}% | ` +
    `TC: ${s.tcActive ? 'ON' : 'off'} | ` +
    `GPS: ${s.gpsLat!.toFixed(6)}, ${s.gpsLon!.toFixed(6)}`
  );
}
```

### Plot speed trace for a map overlay

```typescript
const lap = new Lap({ session, lapIndex: 1, requireGps: true });
const trace = lap.gpsTrace()!;
const speeds = lap.channel('speed')!;  // raw Float64Array, one per sample

const points = trace.map(([lat, lon], i) => ({
  lat, lon,
  speed: speeds[i],
  color: speedToColor(speeds[i]),
}));
```

### Detect TC interventions

```typescript
const lap = session.lap(4);

if (lap.has.throttleActual) {
  const tcZones: { start: number; end?: number; peakRpm: number }[] = [];
  let inTC = false;
  let peakRpm = 0;

  for (const s of lap.samples) {
    if (s.tcActive && !inTC) {
      tcZones.push({ start: s.trackPosition, peakRpm: s.rpm ?? 0 });
      inTC = true;
      peakRpm = s.rpm ?? 0;
    } else if (s.tcActive && inTC) {
      peakRpm = Math.max(peakRpm, s.rpm ?? 0);
    } else if (!s.tcActive && inTC) {
      const zone = tcZones[tcZones.length - 1];
      zone.end = s.trackPosition;
      zone.peakRpm = peakRpm;
      inTC = false;
    }
  }
  console.log(`TC intervened ${tcZones.length} times this lap`);
}
```

### Analyze understeer via wheel speed differential

```typescript
const lap = session.lap(2);

if (lap.has.wheelSpeeds) {
  const turn1 = lap.slice(0.15, 0.22);
  for (const s of turn1) {
    // Front slip: if front wheels are slower than rears → understeer
    const frontAvg = ((s.wheelSpeedFL ?? 0) + (s.wheelSpeedFR ?? 0)) / 2;
    const rearAvg = ((s.wheelSpeedRL ?? 0) + (s.wheelSpeedRR ?? 0)) / 2;
    const slipRatio = rearAvg > 0 ? (rearAvg - frontAvg) / rearAvg : 0;

    if (slipRatio > 0.03) {
      console.log(`Understeer at ${(s.trackPosition * 100).toFixed(1)}%: ` +
                  `front ${frontAvg.toFixed(0)} vs rear ${rearAvg.toFixed(0)} km/h`);
    }
  }
}
```

---

## File Format Support

| Format | Extension | Parser | Laps From | GPS Source | Sectors |
|---|---|---|---|---|---|
| MoTeC i2 | `.ld` + `.ldx` | Binary | LDX beacon markers | Channel data | No |
| Pi/Cosworth | `.pds` | Binary | Lap beacon, lap number, distance reset, lap time reset | Channel data | No |
| VBOX | `.vbo` | Text | `Lap_Number` channel or GPS S/F crossing via `[laptiming]` lines | Native GPS columns | Yes (`[laptiming]` splits) |
| GoPro video | `.mp4` | Binary (GPMF) | GPS S/F crossing | GPMF GPS5 atoms | No |

### VBO-specific notes

VBO files from VBOX loggers are GPS-native — every data point has lat/lon/alt/velocity/heading. This means:
- `positionSource` is always `'gps'` for VBO data
- GPS quality tends to be very high (20Hz RTK GPS in VBOX Sport/Pro)
- The `[laptiming]` section defines start/finish and split lines as GPS gate coordinates, enabling automatic sector timing
- Coordinates may be in NMEA (DDMM.MMMMM), VBOX minutes, or decimal degrees — auto-detected and converted
- `heading` is natively available at full sample rate — `yawRate` is derived from heading delta when no dedicated gyro exists
- `satellites` and `solution_type` feed into GPS quality filtering for arc-length computation
- `Car_On_Jack` channel (when present) indicates the car is on jack stands in the pit — feeds into `LapKind` classification (see "Lap Classification" section)
- `TC_Active` is a direct boolean channel from the ECU — preferred over derived TC detection

---

## Top-Level API

```typescript
// Parse any supported file
async function parseFile(path: string): Promise<Session>;
async function parseFile(file: File): Promise<Session>;
async function parseFile(data: Uint8Array, format: 'ld' | 'pds' | 'vbo'): Promise<Session>;

// Parse with explicit format
async function parseMoTeC(input: string | File | Uint8Array): Promise<Session>;
async function parsePDS(input: string | File | Uint8Array): Promise<Session>;
async function parseVBO(input: string | File | Uint8Array): Promise<Session>;
```

---

## Non-Goals (v1)

- Writing/exporting telemetry files (read-only library)
- Real-time streaming
- Multi-car session alignment (different cars on track simultaneously)
- Video sync (handled by RacecraftViewer separately)
- Tire temperature / pressure channels (add later)
- Engine temperature / oil pressure (add later)
- Predictive lap time / simulation
