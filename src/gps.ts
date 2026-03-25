/**
 * GPS utilities: haversine, arc-length, quality filtering,
 * coordinate conversions, and adaptive smoothing.
 */

import {
  EARTH_RADIUS_M,
  MIN_GPS_SATELLITES, GPS_HIGH_QUALITY_SATELLITES,
  GPS_JUMP_FACTOR, GPS_TELEPORT_THRESHOLD_M,
  GPS_STATIONARY_SPEED_KMH, GPS_STATIONARY_JITTER_M,
} from './constants';

/** Haversine distance in meters between two WGS84 points. */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Convert NMEA coordinate (DDMM.MMMMM) to decimal degrees. */
export function nmeaToDecimal(nmea: number): number {
  if (nmea === 0) return 0;
  const sign = nmea < 0 ? -1 : 1;
  const abs = Math.abs(nmea);
  const degrees = Math.floor(abs / 100);
  const minutes = abs - degrees * 100;
  return sign * (degrees + minutes / 60);
}

/** Convert VBOX minutes to decimal degrees. */
export function vboxMinutesToDecimal(totalMinutes: number): number {
  return totalMinutes / 60;
}

/** Convert radians to decimal degrees. */
export function radiansToDegrees(rad: number): number {
  return rad * (180 / Math.PI);
}

// ── GPS Quality Filtering ────────────────────────────────────────────

export interface GpsFilterResult {
  valid: boolean[];
  /** Count of invalid samples */
  invalidCount: number;
}

/**
 * Filter GPS samples for arc-length computation.
 * Marks samples as invalid when they show jumps, jitter, or poor fix quality.
 */
export function filterGpsForArcLength(
  gpsLat: Float64Array,
  gpsLon: Float64Array,
  speed: Float64Array,
  sampleRate: number,
  satellites?: Float64Array | null,
  fix?: Float64Array | null,
): GpsFilterResult {
  const n = gpsLat.length;
  const valid = new Array<boolean>(n).fill(true);
  let invalidCount = 0;

  for (let i = 1; i < n; i++) {
    const dt = 1 / sampleRate;
    const gpsDist = haversine(gpsLat[i - 1], gpsLon[i - 1], gpsLat[i], gpsLon[i]);
    const expectedDist = (speed[i] / 3.6) * dt;

    // Satellite count check
    if (satellites && satellites[i] < MIN_GPS_SATELLITES) {
      valid[i] = false;
      invalidCount++;
      continue;
    }

    // Fix quality check
    if (fix && fix[i] === 0) {
      valid[i] = false;
      invalidCount++;
      continue;
    }

    // Speed sanity: GPS jump vs expected movement
    if (expectedDist > 0.5 && gpsDist > expectedDist * GPS_JUMP_FACTOR) {
      valid[i] = false;
      invalidCount++;
      continue;
    }

    // Stationary jitter
    if (speed[i] < GPS_STATIONARY_SPEED_KMH && gpsDist < GPS_STATIONARY_JITTER_M) {
      valid[i] = false;
      invalidCount++;
      continue;
    }

    // Teleportation
    if (gpsDist > GPS_TELEPORT_THRESHOLD_M) {
      valid[i] = false;
      invalidCount++;
      continue;
    }
  }

  return { valid, invalidCount };
}

// ── GPS Arc Length ────────────────────────────────────────────────────

/**
 * Compute cumulative arc length from GPS coordinates.
 * Falls back to speed integration for invalid GPS samples.
 */
export function computeGpsArcLength(
  gpsLat: Float64Array,
  gpsLon: Float64Array,
  speed: Float64Array,
  sampleRate: number,
  valid: boolean[],
): Float64Array {
  const n = gpsLat.length;
  const arcLengths = new Float64Array(n);

  for (let i = 1; i < n; i++) {
    let increment: number;
    if (valid[i] && valid[i - 1]) {
      increment = haversine(gpsLat[i - 1], gpsLon[i - 1], gpsLat[i], gpsLon[i]);
    } else {
      // Fall back to speed integration
      increment = (speed[i] / 3.6) * (1 / sampleRate);
    }
    arcLengths[i] = arcLengths[i - 1] + increment;
  }

  return arcLengths;
}

/**
 * Convert arc lengths to track position (0.0–1.0) for a lap range.
 */
export function arcLengthToTrackPosition(
  arcLengths: Float64Array,
  startIdx: number,
  endIdx: number,
): Float64Array {
  const n = endIdx - startIdx;
  const result = new Float64Array(n);
  const startArc = arcLengths[startIdx];
  const totalArc = arcLengths[endIdx - 1] - startArc;

  if (totalArc <= 0) {
    // Zero-distance lap: all positions are 0
    return result;
  }

  for (let i = 0; i < n; i++) {
    result[i] = (arcLengths[startIdx + i] - startArc) / totalArc;
  }

  return result;
}

// ── Speed-integrated distance ────────────────────────────────────────

/**
 * Integrate speed (km/h) over time to produce cumulative distance (meters).
 */
export function integrateSpeed(speed: Float64Array, sampleRate: number): Float64Array {
  const n = speed.length;
  const dist = new Float64Array(n);
  const dt = 1 / sampleRate;

  for (let i = 1; i < n; i++) {
    dist[i] = dist[i - 1] + (speed[i] / 3.6) * dt;
  }

  return dist;
}

// ── GPS Smoothing ────────────────────────────────────────────────────

/**
 * Adaptive Gaussian smoothing of GPS coordinates.
 * Kernel width scales with speed (wider on straights, narrower in corners)
 * and widens when satellite count is low.
 */
export function smoothGps(
  lat: Float64Array,
  lon: Float64Array,
  speed: Float64Array,
  valid: boolean[],
  sampleRate: number,
  satellites?: Float64Array | null,
): { lat: Float64Array; lon: Float64Array } {
  const n = lat.length;
  const smoothedLat = new Float64Array(n);
  const smoothedLon = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    if (!valid[i]) {
      smoothedLat[i] = lat[i];
      smoothedLon[i] = lon[i];
      continue;
    }

    const speedKmh = speed[i];
    const satBoost = satellites && satellites[i] < GPS_HIGH_QUALITY_SATELLITES ? 2 : 0;
    const halfWidth = Math.max(1, Math.min(10, Math.round(1 + speedKmh / 50 + satBoost)));

    let sumLat = 0, sumLon = 0, sumW = 0;
    const sigma = halfWidth / 2;
    for (let j = -halfWidth; j <= halfWidth; j++) {
      const k = i + j;
      if (k < 0 || k >= n || !valid[k]) continue;
      const w = Math.exp(-(j * j) / (2 * sigma * sigma));
      sumLat += lat[k] * w;
      sumLon += lon[k] * w;
      sumW += w;
    }
    smoothedLat[i] = sumW > 0 ? sumLat / sumW : lat[i];
    smoothedLon[i] = sumW > 0 ? sumLon / sumW : lon[i];
  }

  // Patch invalid samples by linear interpolation
  let lastValid = -1;
  for (let i = 0; i < n; i++) {
    if (valid[i]) {
      if (lastValid >= 0 && i - lastValid > 1) {
        for (let j = lastValid + 1; j < i; j++) {
          const t = (j - lastValid) / (i - lastValid);
          smoothedLat[j] = smoothedLat[lastValid] + t * (smoothedLat[i] - smoothedLat[lastValid]);
          smoothedLon[j] = smoothedLon[lastValid] + t * (smoothedLon[i] - smoothedLon[lastValid]);
        }
      }
      lastValid = i;
    }
  }

  return { lat: smoothedLat, lon: smoothedLon };
}

// ── Coordinate system detection ──────────────────────────────────────

export type CoordinateSystem = 'decimal' | 'nmea' | 'vbox_minutes' | 'radians';

/**
 * Detect the coordinate system from raw GPS values.
 * Samples a few values to decide.
 */
export function detectCoordinateSystem(
  latValues: Float64Array,
  lonValues: Float64Array,
): CoordinateSystem {
  // Find first non-zero pair
  let sampleLat = 0, sampleLon = 0;
  for (let i = 0; i < latValues.length; i++) {
    if (latValues[i] !== 0 && lonValues[i] !== 0) {
      sampleLat = Math.abs(latValues[i]);
      sampleLon = Math.abs(lonValues[i]);
      break;
    }
  }

  if (sampleLat === 0 && sampleLon === 0) return 'decimal';

  // Radians: values < 3.15 (< π)
  if (sampleLat < 3.15 && sampleLon < 3.15) return 'radians';

  // NMEA: DDMM.MMMMM format — lat > 100, lon often > 100
  // Degrees part fits in [0,90] for lat and [0,180] for lon
  if (sampleLat > 100 || sampleLon > 200) {
    const latDeg = Math.floor(sampleLat / 100);
    const latMin = sampleLat - latDeg * 100;
    const lonDeg = Math.floor(sampleLon / 100);
    const lonMin = sampleLon - lonDeg * 100;
    if (latDeg <= 90 && latMin < 60 && lonDeg <= 180 && lonMin < 60) {
      return 'nmea';
    }
  }

  // VBOX minutes: divide by 60 gives valid degrees
  if (sampleLat > 90 || sampleLon > 180) {
    const latDeg = sampleLat / 60;
    const lonDeg = sampleLon / 60;
    if (latDeg <= 90 && lonDeg <= 180) {
      return 'vbox_minutes';
    }
  }

  // Default: decimal degrees
  return 'decimal';
}

/**
 * Convert an array of coordinates from detected system to decimal degrees.
 */
export function convertCoordinates(
  values: Float64Array,
  system: CoordinateSystem,
): Float64Array {
  if (system === 'decimal') return values;

  const result = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    switch (system) {
      case 'nmea':
        result[i] = nmeaToDecimal(values[i]);
        break;
      case 'vbox_minutes':
        result[i] = vboxMinutesToDecimal(values[i]);
        break;
      case 'radians':
        result[i] = radiansToDegrees(values[i]);
        break;
    }
  }
  return result;
}
