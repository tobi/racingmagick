/**
 * Domain constants for motorsport telemetry.
 *
 * Single source of truth for physical reality constraints, classification
 * thresholds, and tuning parameters. Avoids scattering magic numbers
 * throughout the codebase.
 */

// ── Physics ─────────────────────────────────────────────────────────

export const EARTH_RADIUS_M = 6_371_000;

// ── Resampling ──────────────────────────────────────────────────────

/** Maximum output sample rate (Hz). Higher-rate sources are down-sampled. */
export const MAX_SAMPLE_RATE_HZ = 100;

// ── Lap Classification ──────────────────────────────────────────────

/** Speed (km/h) below which a car is considered in the pit lane. */
export const PIT_SPEED_THRESHOLD_KMH = 60;

/** Minimum speed (km/h) during a lap — below this the car is practically stopped. */
export const MIN_MOVING_SPEED_KMH = 10;

/** Minimum duration (seconds) for a lap to be considered valid (not a fragment). */
export const MIN_LAP_DURATION_S = 30;

// ── GPS Quality ─────────────────────────────────────────────────────

/** Minimum satellite count for reliable GPS fix. */
export const MIN_GPS_SATELLITES = 4;

/** Minimum satellite count for high-quality smoothing (below → wider kernel). */
export const GPS_HIGH_QUALITY_SATELLITES = 8;

/** GPS jump threshold: if GPS distance > expected * this factor, mark invalid. */
export const GPS_JUMP_FACTOR = 3;

/** Maximum GPS single-step distance (meters) before marking as teleportation. */
export const GPS_TELEPORT_THRESHOLD_M = 100;

/** Minimum speed (km/h) to consider GPS movement valid (below → jitter filter). */
export const GPS_STATIONARY_SPEED_KMH = 5;

/** Minimum GPS distance (meters) when stationary to not be considered jitter. */
export const GPS_STATIONARY_JITTER_M = 3;

/** Fraction of invalid GPS samples above which we fall back to distance-based position. */
export const GPS_INVALID_FRACTION_THRESHOLD = 0.5;

// ── Interpolation ───────────────────────────────────────────────────

/** EMA alpha for speed-aware interpolation bias. */
export const SPEED_BIAS_ALPHA = 0.7;

/** Lookback window (samples) for speed-aware interpolation. */
export const SPEED_BIAS_LOOKBACK = 4;

// ── Lint Thresholds ─────────────────────────────────────────────────

/** Maximum plausible vehicle speed (km/h). */
export const MAX_VEHICLE_SPEED_KMH = 400;

/** Maximum plausible engine RPM. */
export const MAX_RPM = 20_000;

/** Maximum plausible G-force magnitude. */
export const MAX_G_FORCE = 30;

/** Maximum plausible lap time for a timed lap (seconds). */
export const MAX_LAP_TIME_S = 9 * 60;

/** Maximum session duration (seconds). */
export const MAX_SESSION_DURATION_S = 24 * 3600;

/** Session duration warning threshold (seconds). */
export const LONG_SESSION_THRESHOLD_S = 2 * 3600;

/** Lap time outlier ratio — flag laps >3x or <0.33x the median. */
export const LAP_TIME_OUTLIER_RATIO = 3;

/** Maximum plausible track length (meters). */
export const MAX_TRACK_LENGTH_M = 30_000;

/** Minimum plausible flying-lap distance (meters). */
export const MIN_FLYING_LAP_DISTANCE_M = 500;

/** Throttle threshold for TC active detection. */
export const TC_ACTIVE_THRESHOLD = 0.02;

// ── Channel Normalization ───────────────────────────────────────────

/** Channels that use nearest-neighbor interpolation during resampling. */
export const DISCRETE_CHANNELS = new Set([
  'gear',
  'lapNumber',
  'carOnJack',
  'gpsFix',
  'gpsSatellites',
]);

/** Prefix applied to unresolved (custom) channels to avoid collision with canonical names. */
export const CUSTOM_CHANNEL_PREFIX = 'raw_';

// ── Binary Parser Limits ────────────────────────────────────────────

/** Maximum channels in a single file (safety limit). */
export const MAX_CHANNELS_PER_FILE = 200;

/** MoTeC .ld file magic number. */
export const MOTEC_MAGIC = 0x40;

/** MoTeC channel metadata record size (bytes). */
export const MOTEC_CHANNEL_META_SIZE = 124;

/** Minimum file size for a valid MoTeC .ld file (bytes). */
export const MOTEC_MIN_FILE_SIZE = 0x1A0;
