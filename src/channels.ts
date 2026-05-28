/**
 * Channel resolution via priority lists.
 *
 * Each canonical channel has an ordered list of [pattern, transform?] entries.
 * When resolving raw channel names from a telemetry file, we walk the priority
 * list top-to-bottom and take the first match. The optional transform converts
 * the raw value+unit into the normalized unit for that channel.
 *
 * This is the single source of truth for name matching AND unit normalization.
 * Shared across all formats (MoTeC, PDS, VBO).
 */

// ── Types ────────────────────────────────────────────────────────────

/** Transform: (rawValue, unitString) → normalizedValue */
export type ChannelTransform = (value: number, unit: string) => number;

/** One entry in a channel's priority list */
export type ChannelPriority = [pattern: string, transform: ChannelTransform | null];

// ── Unit transforms (reusable lambdas) ───────────────────────────────

export const toKmh: ChannelTransform = (v, u) => {
  const ul = u.toLowerCase().trim().replace(/\s+/g, '');
  if (['m/s', 'ms', 'mps', 'meter/second', 'meters/second', 'metre/second', 'metres/second'].includes(ul)) return v * 3.6;
  if (['mph', 'mi/h', 'mile/hour', 'miles/hour'].includes(ul)) return v * 1.609344;
  if (['knots', 'knot', 'kn', 'kt', 'kts'].includes(ul)) return v * 1.852;
  return v;
};

export const toRatio: ChannelTransform = (v, u) => {
  const ul = u.toLowerCase().trim().replace(/\s+/g, '');
  if (ul === '%' || ul === 'pct' || ul === 'percent' || ul === 'percentage') return v / 100;
  if (ul === 'deg' || ul === '°') return v / 100;
  if (ul === 'rad') return v / 1.745;
  // Heuristic fallback: only for channels whose unit is empty but values
  // consistently look like 0–100 percentages. Threshold raised to avoid
  // false positives on legitimate small ratios > 1.0 (e.g., brake bias 1.2).
  if (ul === '' && v > 5) return v / 100;
  return v;
};

export const toBar: ChannelTransform = (v, u) => {
  const ul = u.toLowerCase().trim().replace(/\s+/g, '');
  if (ul === 'psi' || ul === 'lb/in2' || ul === 'lbf/in2') return v * 0.0689476;
  if (ul === 'kpa') return v * 0.01;
  if (ul === 'mpa') return v * 10;
  if (ul === 'mbar') return v * 0.001;
  if (ul === 'pa') return v * 0.00001;
  return v;
};

export const toDeg: ChannelTransform = (v, u) => {
  const ul = u.toLowerCase().trim().replace(/\s+/g, '');
  if (ul === 'rad' || ul === 'radian' || ul === 'radians') return v * (180 / Math.PI);
  return v;
};

export const toDecimalDeg: ChannelTransform = (v, u) => {
  const ul = u.toLowerCase().trim().replace(/\s+/g, '');
  if (ul === 'rad' || ul === 'radian' || ul === 'radians') return v * (180 / Math.PI);
  return v;
};

export const toMetersAlt: ChannelTransform = (v, u) => {
  const ul = u.toLowerCase().trim().replace(/\s+/g, '');
  if (ul === 'ft' || ul === 'feet' || ul === 'foot') return v * 0.3048;
  if (ul === 'km') return v * 1000;
  if (ul === 'mi' || ul === 'mile' || ul === 'miles') return v * 1609.344;
  return v;
};

export const toG: ChannelTransform = (v, u) => {
  const ul = u.toLowerCase().trim().replace(/\s+/g, '');
  if (ul === 'm/s2' || ul === 'm/s²' || ul === 'ms2' || ul === 'mps2') return v / 9.81;
  return v;
};

export const toDegPerSec: ChannelTransform = (v, u) => {
  const ul = u.toLowerCase().trim().replace(/\s+/g, '');
  if (ul === 'rad/s' || ul === 'rads' || ul === 'radian/s' || ul === 'radians/s') return v * (180 / Math.PI);
  return v;
};

export const toMeters: ChannelTransform = (v, u) => {
  const ul = u.toLowerCase().trim().replace(/\s+/g, '');
  if (ul === 'km') return v * 1000;
  if (ul === 'mi' || ul === 'mile' || ul === 'miles') return v * 1609.344;
  if (ul === 'ft' || ul === 'feet' || ul === 'foot') return v * 0.3048;
  return v;
};

export const toCelsius: ChannelTransform = (v, u) => {
  const ul = u.toLowerCase().trim().replace(/\s+/g, '');
  if (ul === 'f' || ul === '°f' || ul === 'degf' || ul === 'fahrenheit') return (v - 32) * 5 / 9;
  if (ul === 'k' || ul === 'kelvin') return v - 273.15;
  return v;
};

export const toMillimeters: ChannelTransform = (v, u) => {
  const ul = u.toLowerCase().trim().replace(/\s+/g, '');
  if (ul === 'm' || ul === 'meter' || ul === 'meters' || ul === 'metre' || ul === 'metres') return v * 1000;
  if (ul === 'cm' || ul === 'centimeter' || ul === 'centimeters' || ul === 'centimetre' || ul === 'centimetres') return v * 10;
  if (ul === 'in' || ul === 'inch' || ul === 'inches') return v * 25.4;
  return v;
};

export const toNewtons: ChannelTransform = (v, u) => {
  const ul = u.toLowerCase().trim().replace(/\s+/g, '');
  if (ul === 'kn') return v * 1000;
  if (ul === 'lbf' || ul === 'lb') return v * 4.4482216152605;
  if (ul === 'kgf' || ul === 'kg') return v * 9.80665;
  return v;
};

// ── The priority table ───────────────────────────────────────────────
//
// For each canonical channel: an ordered list of [pattern, transform?].
// Patterns are matched case-insensitively against normalized channel names
// (lowercase, punctuation stripped). First match wins.
//
// Order within each list matters — put the most specific/preferred name first.

export const CHANNEL_PRIORITIES: Record<string, ChannelPriority[]> = {
  // ── Required channels ──────────────────────────────────────────────

  speed: [
    ['corr speed', toKmh],
    ['ground speed', toKmh],
    ['wheel speed avg', toKmh],
    ['vehicle speed', toKmh],
    ['vehiclespeed', toKmh],
    ['speed ref', toKmh],
    ['speedref', toKmh],
    ['vehrefspeed', toKmh],
    ['speed wspd app', toKmh],
    ['uspeed', toKmh],
    ['speed', toKmh],
  ],

  throttle: [
    ['driver throttle pos', toRatio],
    ['fbwdrivertps', toRatio],
    ['pps', toRatio],
    ['accel pedal pos', toRatio],
    ['acc pedal pos', toRatio],
    ['throttle pedal', toRatio],
    ['throttlepedal', toRatio],
    ['pps map', toRatio],
    ['ppsmap', toRatio],
    ['accelerator position', toRatio],
    ['aps fer', toRatio],
    ['aps', toRatio],
    ['ath', toRatio],
  ],

  throttleActual: [
    ['throttle pos', toRatio],
    ['tps', toRatio],
    ['tpsreal', toRatio],
    ['aps actual', toRatio],
  ],

  distance: [
    ['lap distance corrected', toMeters],
    ['lap distance', toMeters],
    ['distance wspd app', toMeters],
    ['distance', toMeters],
  ],

  // ── Engine ─────────────────────────────────────────────────────────

  rpm: [
    ['engine rpm', null],
    ['rpm', null],
    ['eng rpm', null],
    ['n engine', null],
    ['nengine', null],
    ['engine speed', null],
    ['enginespeed', null],
    ['eng n', null],
    ['nmot', null],
  ],

  gear: [
    ['gear pos', null],
    ['gearposdisplay', null],
    ['gear', null],
  ],

  // ── Brakes ─────────────────────────────────────────────────────────

  brakePedal: [
    ['brake pedal pos', toRatio],
    ['brake pedal', toRatio],
    ['brake pos', toRatio],
  ],

  brakePressure: [
    ['brake pressure f', toBar],
    ['brake pressure fr', toBar],
    ['p f brake', toBar],
    ['brake pressure front', toBar],
    ['pbrake f', toBar],
  ],

  brakePressureRear: [
    ['brake pressure r', toBar],
    ['brake pressure rr', toBar],
    ['p r brake', toBar],
    ['brake pressure rear', toBar],
    ['pbrake r', toBar],
  ],

  // ── Clutch ─────────────────────────────────────────────────────────

  clutchPedal: [
    ['clutch pedal', toRatio],
    ['clutch position', toRatio],
    ['clutch pos', toRatio],
    ['clutch', toRatio],
  ],

  clutchActual: [
    ['clutch actuator', toRatio],
    ['clutch act pos', toRatio],
  ],

  // ── Steering ───────────────────────────────────────────────────────

  steering: [
    ['steering angle', toDeg],
    ['steer', toDeg],
  ],

  // ── Traction control ───────────────────────────────────────────────

  tcCut: [
    ['tc throttle cut', toRatio],
    ['tc cut', toRatio],
    ['tccut', toRatio],
    ['tc throttle reduction', toRatio],
  ],

  tcSlip: [
    ['tc slip target', toRatio],
    ['tc slip', toRatio],
    ['tcslip', toRatio],
  ],

  // ── Dynamics ───────────────────────────────────────────────────────

  gLong: [
    ['g force long', toG],
    ['i accel long', toG],
    ['fia accelx', toG],
    ['comboacc', toG],
    ['combo acc', toG],
  ],

  gLat: [
    ['g force lat', toG],
    ['i accel lat', toG],
    ['fia accely', toG],
    ['combo g', toG],
    ['combog', toG],
  ],

  heading: [
    ['heading', toDeg],
    ['gps heading', toDeg],
    ['fia gpsheading', toDeg],
  ],

  yawRate: [
    ['yaw rate', toDegPerSec],
    ['yaw velocity', toDegPerSec],
    ['gyro z', toDegPerSec],
  ],

  // ── GPS ────────────────────────────────────────────────────────────

  gpsLat: [
    ['fia gpslatn', toDecimalDeg],
    ['gps latitude', toDecimalDeg],
    ['latitude', toDecimalDeg],
    ['lat', toDecimalDeg],
  ],

  gpsLon: [
    ['fia gpslonge', toDecimalDeg],
    ['gps longitude', toDecimalDeg],
    ['longitude', toDecimalDeg],
    ['long', toDecimalDeg],
  ],

  gpsAlt: [
    ['gps altitude', toMetersAlt],
    ['fia gpsalt', toMetersAlt],
    ['gps alt', toMetersAlt],
    ['height', toMetersAlt],
  ],

  gpsSpeed: [
    ['fia gpsvel', toKmh],
    ['gps speed', toKmh],
    ['velocity kmh', toKmh],
    ['velocity', toKmh],
  ],

  gpsSatellites: [
    ['satellites', null],
    ['sats', null],
    ['gps sats', null],
    ['gps satellites', null],
  ],

  gpsFix: [
    ['solution type', null],
    ['fix type', null],
    ['gps fix', null],
  ],

  // ── Wheel speeds ───────────────────────────────────────────────────

  wheelSpeedFL: [
    ['wheel speed fl', toKmh],
    ['wspd fl', toKmh],
    ['v fl wheel', toKmh],
    ['whl spd fl', toKmh],
    ['wheel speed lf', toKmh],
    ['front left wheel speed', toKmh],
    ['whlspeed fl', toKmh],
    ['fl speed', toKmh],
  ],

  wheelSpeedFR: [
    ['wheel speed fr', toKmh],
    ['wspd fr', toKmh],
    ['v fr wheel', toKmh],
    ['whl spd fr', toKmh],
    ['wheel speed rf', toKmh],
    ['front right wheel speed', toKmh],
    ['whlspeed fr', toKmh],
    ['fr speed', toKmh],
  ],

  wheelSpeedRL: [
    ['wheel speed rl', toKmh],
    ['wspd rl', toKmh],
    ['v rl wheel', toKmh],
    ['whl spd rl', toKmh],
    ['wheel speed lr', toKmh],
    ['rear left wheel speed', toKmh],
    ['whlspeed rl', toKmh],
    ['rl speed', toKmh],
  ],

  wheelSpeedRR: [
    ['wheel speed rr', toKmh],
    ['wspd rr', toKmh],
    ['v rr wheel', toKmh],
    ['whl spd rr', toKmh],
    ['rear right wheel speed', toKmh],
    ['whlspeed rr', toKmh],
    ['rr speed', toKmh],
  ],

  // ── Dampers ────────────────────────────────────────────────────────

  damperFL: [['x fl damper', toMillimeters], ['damper travel fl', toMillimeters]],
  damperFR: [['x fr damper', toMillimeters], ['damper travel fr', toMillimeters]],
  damperRL: [['x rl damper', toMillimeters], ['damper travel rl', toMillimeters]],
  damperRR: [['x rr damper', toMillimeters], ['damper travel rr', toMillimeters]],

  // ── Tire pressures (→ bar) ─────────────────────────────────────────

  tirePressureFL: [['tire pressure fl', toBar], ['p tyre fl', toBar], ['tyre pressure fl', toBar]],
  tirePressureFR: [['tire pressure fr', toBar], ['p tyre fr', toBar], ['tyre pressure fr', toBar]],
  tirePressureRL: [['tire pressure rl', toBar], ['p tyre rl', toBar], ['tyre pressure rl', toBar]],
  tirePressureRR: [['tire pressure rr', toBar], ['p tyre rr', toBar], ['tyre pressure rr', toBar]],

  // ── Tire temperatures (→ °C) ───────────────────────────────────────
  // Priority: core temp > middle temp > general temp > PDS tyre temp

  tireTempFL: [['tire temp core fl', toCelsius], ['tire temp middle fl', toCelsius], ['tire temp fl', toCelsius], ['t tyre fl', toCelsius], ['tyre temp fl', toCelsius]],
  tireTempFR: [['tire temp core fr', toCelsius], ['tire temp middle fr', toCelsius], ['tire temp fr', toCelsius], ['t tyre fr', toCelsius], ['tyre temp fr', toCelsius]],
  tireTempRL: [['tire temp core rl', toCelsius], ['tire temp middle rl', toCelsius], ['tire temp rl', toCelsius], ['t tyre rl', toCelsius], ['tyre temp rl', toCelsius]],
  tireTempRR: [['tire temp core rr', toCelsius], ['tire temp middle rr', toCelsius], ['tire temp rr', toCelsius], ['t tyre rr', toCelsius], ['tyre temp rr', toCelsius]],

  // ── Tire slip angles (→ degrees) ───────────────────────────────────

  tireSlipAngleFL: [['tire slip angle fl', toDeg], ['slip angle fl', toDeg]],
  tireSlipAngleFR: [['tire slip angle fr', toDeg], ['slip angle fr', toDeg]],
  tireSlipAngleRL: [['tire slip angle rl', toDeg], ['slip angle rl', toDeg]],
  tireSlipAngleRR: [['tire slip angle rr', toDeg], ['slip angle rr', toDeg]],

  // ── Tire slip ratios (dimensionless) ───────────────────────────────

  tireSlipRatioFL: [['tire slip ratio fl', toRatio], ['slip ratio fl', toRatio]],
  tireSlipRatioFR: [['tire slip ratio fr', toRatio], ['slip ratio fr', toRatio]],
  tireSlipRatioRL: [['tire slip ratio rl', toRatio], ['slip ratio rl', toRatio]],
  tireSlipRatioRR: [['tire slip ratio rr', toRatio], ['slip ratio rr', toRatio]],

  // ── Tire wear (0–1) ────────────────────────────────────────────────

  tireWearFL: [['tire wear fl', toRatio]],
  tireWearFR: [['tire wear fr', toRatio]],
  tireWearRL: [['tire wear rl', toRatio]],
  tireWearRR: [['tire wear rr', toRatio]],

  // ── Tire load (N) ──────────────────────────────────────────────────

  tireLoadFL: [['tire load fl', toNewtons]],
  tireLoadFR: [['tire load fr', toNewtons]],
  tireLoadRL: [['tire load rl', toNewtons]],
  tireLoadRR: [['tire load rr', toNewtons]],

  // ── Internal (not on LapSample) ────────────────────────────────────

  carOnJack: [['car on jack', null], ['pit limiter', null]],
  lapNumber: [['lap number', null]],
  lapGainLoss: [['lap gain loss', null]],
  driverId: [['driverid', null], ['driver id', null], ['driver_id', null]],
};

export type CanonicalChannel = keyof typeof CHANNEL_PRIORITIES;

/** Canonical engineering unit for each normalized channel exposed by the public API. */
export const NORMALIZED_CHANNEL_UNITS: Record<string, string> = {
  time: 's',
  distance: 'm',
  trackPosition: 'ratio',
  speed: 'km/h',
  throttle: 'ratio',
  throttleActual: 'ratio',
  rpm: 'rpm',
  gear: 'gear',
  brakePedal: 'ratio',
  brakePressure: 'bar',
  brakePressureRear: 'bar',
  clutchPedal: 'ratio',
  clutchActual: 'ratio',
  steering: 'deg',
  tcCut: 'ratio',
  tcSlip: 'ratio',
  gLong: 'g',
  gLat: 'g',
  heading: 'deg',
  yawRate: 'deg/s',
  gpsLat: 'deg',
  gpsLon: 'deg',
  gpsAlt: 'm',
  gpsSpeed: 'km/h',
  gpsSatellites: 'count',
  gpsFix: 'fix',
  wheelSpeedFL: 'km/h',
  wheelSpeedFR: 'km/h',
  wheelSpeedRL: 'km/h',
  wheelSpeedRR: 'km/h',
  damperFL: 'mm',
  damperFR: 'mm',
  damperRL: 'mm',
  damperRR: 'mm',
  tirePressureFL: 'bar',
  tirePressureFR: 'bar',
  tirePressureRL: 'bar',
  tirePressureRR: 'bar',
  tireTempFL: '°C',
  tireTempFR: '°C',
  tireTempRL: '°C',
  tireTempRR: '°C',
  tireSlipAngleFL: 'deg',
  tireSlipAngleFR: 'deg',
  tireSlipAngleRL: 'deg',
  tireSlipAngleRR: 'deg',
  tireSlipRatioFL: 'ratio',
  tireSlipRatioFR: 'ratio',
  tireSlipRatioRL: 'ratio',
  tireSlipRatioRR: 'ratio',
  tireWearFL: 'ratio',
  tireWearFR: 'ratio',
  tireWearRL: 'ratio',
  tireWearRR: 'ratio',
  tireLoadFL: 'N',
  tireLoadFR: 'N',
  tireLoadRL: 'N',
  tireLoadRR: 'N',
  carOnJack: 'bool',
  lapNumber: 'count',
  lapGainLoss: 's',
  driverId: 'id',
};

export interface ChannelDefinition {
  readonly name: string;
  readonly unit: string;
  readonly aliases: readonly string[];
  readonly required: boolean;
}

export function getCanonicalUnit(channelName: string): string | undefined {
  return NORMALIZED_CHANNEL_UNITS[channelName];
}

export function getChannelDefinition(channelName: string): ChannelDefinition | undefined {
  const aliases = CHANNEL_PRIORITIES[channelName]?.map(([alias]) => alias);
  const unit = getCanonicalUnit(channelName);
  if (!aliases || !unit) return undefined;
  return {
    name: channelName,
    unit,
    aliases,
    required: channelName === 'speed' || channelName === 'throttle',
  };
}

export function canonicalChannelNames(): string[] {
  return Object.keys(CHANNEL_PRIORITIES);
}

// ── Build a flat lookup for fast resolution ──────────────────────────
// Pre-compute: normalized pattern → { canonical, transform }

interface ResolvedEntry {
  canonical: string;
  transform: ChannelTransform | null;
  priority: number; // lower = higher priority
}

const LOOKUP = new Map<string, ResolvedEntry>();

for (const [canonical, priorities] of Object.entries(CHANNEL_PRIORITIES)) {
  for (let i = 0; i < priorities.length; i++) {
    const [pattern, transform] = priorities[i]!;
    // Store pattern as-is (already lowercase, space-separated)
    const key = pattern.replace(/\s+/g, '');
    if (!LOOKUP.has(key)) {
      LOOKUP.set(key, { canonical, transform, priority: i });
    }
    // Also store with spaces for direct match
    if (!LOOKUP.has(pattern)) {
      LOOKUP.set(pattern, { canonical, transform, priority: i });
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────

/** Normalize a raw channel name to lowercase, strip punctuation. */
export function normalize(rawName: string): string {
  return rawName.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

/**
 * Resolve a raw channel name to its canonical form + optional transform.
 * Returns undefined if not recognized.
 */
export function resolveChannel(rawName: string): { canonical: string; transform: ChannelTransform | null } | undefined {
  const norm = normalize(rawName);

  // Try with spaces
  const withSpaces = LOOKUP.get(norm);
  if (withSpaces) return withSpaces;

  // Try without spaces
  const noSpaces = norm.replace(/\s+/g, '');
  const entry = LOOKUP.get(noSpaces);
  if (entry) return entry;

  // Try with underscores preserved (some formats use them)
  const withUnder = rawName.toLowerCase().replace(/[^a-z0-9_]/g, '').trim().replace(/_/g, '');
  const underEntry = LOOKUP.get(withUnder);
  if (underEntry) return underEntry;

  return undefined;
}

/** Convenience: just the canonical name, for backward compat. */
export function resolveChannelName(rawName: string): string | undefined {
  return resolveChannel(rawName)?.canonical;
}

/** Get the transform for a canonical channel's first priority entry. */
export function getTransform(canonical: string): ChannelTransform | null {
  const priorities = CHANNEL_PRIORITIES[canonical];
  if (!priorities || priorities.length === 0) return null;
  return priorities[0]![1];
}

/**
 * Resolve all raw channels from a file against the priority table.
 *
 * For each canonical channel, walks its priority list and picks the first
 * raw channel whose name matches. Returns a map of canonical → { rawChannel, transform }.
 *
 * This is the main entry point for parsers.
 */
export function resolveAllChannels(
  rawChannels: Array<{ name: string; unit: string }>,
): Map<string, { rawIndex: number; transform: ChannelTransform | null }> {
  // Normalize all raw names once
  const normalizedRaw = rawChannels.map(ch => ({
    norm: normalize(ch.name),
    noSpaces: normalize(ch.name).replace(/\s+/g, ''),
  }));

  const result = new Map<string, { rawIndex: number; transform: ChannelTransform | null }>();

  for (const [canonical, priorities] of Object.entries(CHANNEL_PRIORITIES)) {
    for (const [pattern, transform] of priorities) {
      const patternNoSpaces = pattern.replace(/\s+/g, '');

      // Find first raw channel matching this pattern
      const idx = normalizedRaw.findIndex(r =>
        r.norm === pattern || r.noSpaces === patternNoSpaces,
      );

      if (idx >= 0) {
        result.set(canonical, { rawIndex: idx, transform });
        break; // first match in priority order wins
      }
    }
  }

  return result;
}

/**
 * Throttle resolution: if only one throttle channel exists, it becomes `throttle`.
 * If both exist, driver pedal = `throttle`, post-TC = `throttleActual`.
 * If only post-TC exists, map it to `throttle` as a fallback.
 */
export function resolveThrottleChannels(
  resolved: Map<string, { rawIndex: number; transform: ChannelTransform | null }>,
): { remapped: boolean; warning: string | null } {
  const hasDriver = resolved.has('throttle');
  const hasActual = resolved.has('throttleActual');

  if (hasDriver) return { remapped: false, warning: null };

  if (hasActual && !hasDriver) {
    const actual = resolved.get('throttleActual')!;
    resolved.set('throttle', actual);
    resolved.delete('throttleActual');
    return {
      remapped: true,
      warning: 'No driver throttle channel found; using post-TC throttle as primary',
    };
  }

  return { remapped: false, warning: null };
}

// Re-export transforms for direct use in tests
export {
  toKmh as normalizeSpeed,
  toRatio as normalizeRatio,
  toBar as normalizePressure,
  toG as normalizeG,
  toBar as normalizeTirePressure,
  toCelsius as normalizeTemperature,
  toDeg as normalizeSlipAngle,
  toDegPerSec as normalizeYawRate,
  toMeters as normalizeDistance,
  toMetersAlt as normalizeAltitude,
  toMillimeters as normalizeDamperTravel,
  toNewtons as normalizeLoad,
};
