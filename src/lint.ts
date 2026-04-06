/**
 * Session data quality linter.
 *
 * Returns an array of issues found. Empty array = clean session.
 * Each issue has a severity ('error' = definitely wrong, 'warning' = suspicious).
 *
 * This encodes physical reality constraints for motorsport telemetry:
 * - No car goes faster than 400 km/h
 * - No track lap is longer than 9 minutes
 * - No race session exceeds 24 hours
 * - Throttle/brake/steering must show variability if speed varies
 * - Required channels must exist and have plausible data
 * - etc.
 *
 * Design rules:
 * - Each underlying problem produces ONE warning, not several cascading ones.
 *   If throttle is all-zero, we emit "throttle-no-signal" — not also
 *   "throttle-no-variation" + "throttle-low-max".
 * - "Expected weirdness" doesn't warn. A 24-minute single-lap recording is
 *   informational, not suspicious.
 * - Messages name the symptom AND the likely cause when they differ.
 */

import type { Session } from './session';
import { CH_TIME, CH_DISTANCE, CH_SPEED, CH_THROTTLE } from './types';
import {
  MAX_VEHICLE_SPEED_KMH, MAX_RPM, MAX_G_FORCE, MAX_LAP_TIME_S,
  MAX_SESSION_DURATION_S, LONG_SESSION_THRESHOLD_S, LAP_TIME_OUTLIER_RATIO,
  MAX_TRACK_LENGTH_M, MIN_FLYING_LAP_DISTANCE_M,
} from './constants';

export type IssueSeverity = 'error' | 'warning';

export interface LintIssue {
  readonly severity: IssueSeverity;
  readonly code: string;
  readonly message: string;
  readonly channel?: string;
}

/**
 * Lint a parsed session for data quality issues.
 */
export function lint(session: Session): LintIssue[] {
  const issues: LintIssue[] = [];
  const matrix = session.matrix;

  // ── Session-level checks ─────────────────────────────────────────

  if (session.totalDuration <= 0) {
    issues.push({ severity: 'error', code: 'zero-duration', message: 'Session has zero or negative duration' });
  }
  if (session.totalDuration > MAX_SESSION_DURATION_S) {
    issues.push({ severity: 'error', code: 'excessive-duration', message: `Session duration ${(session.totalDuration/3600).toFixed(1)}h exceeds 24h — probably a parsing error` });
  }
  if (session.totalDuration > LONG_SESSION_THRESHOLD_S) {
    issues.push({ severity: 'warning', code: 'long-session', message: `Session is ${(session.totalDuration/3600).toFixed(1)}h — verify this is a single stint` });
  }

  if (matrix.sampleCount === 0) {
    issues.push({ severity: 'error', code: 'no-samples', message: 'No data samples' });
    return issues; // can't check anything else
  }

  if (session.sampleRate <= 0) {
    issues.push({ severity: 'error', code: 'zero-sample-rate', message: 'Sample rate is zero' });
  }
  if (session.sampleRate < 5) {
    issues.push({ severity: 'warning', code: 'low-sample-rate', message: `Sample rate ${session.sampleRate}Hz is very low for telemetry analysis` });
  }

  const year = session.date.getFullYear();
  if (year < 2000 || year > 2100) {
    issues.push({ severity: 'warning', code: 'bad-date', message: `Session date year ${year} seems wrong` });
  }

  // ── Time channel ─────────────────────────────────────────────────

  const time = matrix.channels[CH_TIME];
  let timeBackwards = 0;
  for (let i = 1; i < time.length; i++) {
    if (time[i]! < time[i - 1]!) timeBackwards++;
  }
  if (timeBackwards > 0) {
    issues.push({ severity: 'error', code: 'time-backwards', message: `Time goes backwards ${timeBackwards} times`, channel: 'time' });
  }

  // ── Speed channel ────────────────────────────────────────────────

  const speed = matrix.channels[CH_SPEED];
  const speedStats = channelStats(speed);

  if (speedStats.nanFrac > 0.01) {
    issues.push({ severity: 'error', code: 'speed-nan', message: `Speed has ${(speedStats.nanFrac*100).toFixed(1)}% NaN values`, channel: 'speed' });
  }
  if (speedStats.max > MAX_VEHICLE_SPEED_KMH) {
    issues.push({ severity: 'error', code: 'speed-too-fast', message: `Max speed ${speedStats.max.toFixed(0)} km/h exceeds ${MAX_VEHICLE_SPEED_KMH} km/h`, channel: 'speed' });
  }
  if (speedStats.min < -5) {
    issues.push({ severity: 'error', code: 'speed-negative', message: `Negative speed ${speedStats.min.toFixed(1)} km/h`, channel: 'speed' });
  }

  // "car barely moved" subsumes any throttle/brake/rpm/gps mapping warnings —
  // if speed never went above 10 km/h, none of those channels are expected
  // to show variation either.
  const carBarelyMoved = speedStats.max < 10 && session.totalDuration > 60;
  const movingButNoSpeedVar = speedStats.stddev < 1 && speedStats.max >= 10 && session.totalDuration > 30;

  if (carBarelyMoved) {
    issues.push({ severity: 'warning', code: 'speed-very-low', message: `Max speed only ${speedStats.max.toFixed(1)} km/h in a ${session.totalDuration.toFixed(0)}s session — car barely moved`, channel: 'speed' });
  } else if (movingButNoSpeedVar) {
    issues.push({ severity: 'warning', code: 'speed-no-variation', message: 'Speed has no variation — constant speed or stuck sensor', channel: 'speed' });
  }

  // ── Driver input channels ───────────────────────────────────────
  // For each pedal/control channel, classify into: missing, no-signal, range-error,
  // or healthy. Emit at most ONE warning per channel.

  const throttle = matrix.channels[CH_THROTTLE];
  const thrStats = channelStats(throttle);

  if (thrStats.nanFrac > 0.01) {
    issues.push({ severity: 'error', code: 'throttle-nan', message: `Throttle has ${(thrStats.nanFrac*100).toFixed(1)}% NaN`, channel: 'throttle' });
  } else if (thrStats.max > 2.0) {
    issues.push({ severity: 'error', code: 'throttle-over-range', message: `Throttle max ${thrStats.max.toFixed(2)} exceeds 1.0 — unit conversion error`, channel: 'throttle' });
  } else if (thrStats.min < -0.1) {
    issues.push({ severity: 'error', code: 'throttle-negative', message: `Throttle min ${thrStats.min.toFixed(2)} is negative`, channel: 'throttle' });
  } else if (!carBarelyMoved && isNoSignal(thrStats)) {
    issues.push({ severity: 'warning', code: 'throttle-no-signal', message: 'Throttle channel exists but is all-zero — pedal not logged or CAN not connected', channel: 'throttle' });
  } else if (!carBarelyMoved && speedStats.stddev > 10 && thrStats.stddev < 0.01) {
    issues.push({ severity: 'warning', code: 'throttle-no-variation', message: 'Speed varies but throttle is constant — possible channel mapping issue', channel: 'throttle' });
  } else if (!carBarelyMoved && speedStats.max > 50 && thrStats.max < 0.5) {
    issues.push({ severity: 'warning', code: 'throttle-low-max', message: `Max throttle only ${(thrStats.max*100).toFixed(0)}% despite reaching ${speedStats.max.toFixed(0)} km/h`, channel: 'throttle' });
  }

  // ── Brake channel ────────────────────────────────────────────────

  const brake = matrix.row('brakePressure');
  if (brake) {
    const brStats = channelStats(brake);
    if (!carBarelyMoved) {
      if (isNoSignal(brStats)) {
        issues.push({ severity: 'warning', code: 'brake-no-signal', message: 'Brake pressure channel exists but is all-zero — sensor not logged or CAN not connected', channel: 'brakePressure' });
      } else if (speedStats.max > 100 && brStats.max < 1) {
        issues.push({ severity: 'warning', code: 'brake-no-pressure', message: 'Car reaches 100+ km/h but brake pressure never exceeds 1 bar', channel: 'brakePressure' });
      } else if (speedStats.stddev > 10 && brStats.stddev < 0.01) {
        issues.push({ severity: 'warning', code: 'brake-no-variation', message: 'Speed varies but brake is constant — channel mapping error', channel: 'brakePressure' });
      }
    }
  } else if (speedStats.max > 50 && !carBarelyMoved) {
    issues.push({ severity: 'warning', code: 'no-brake', message: 'No brake pressure channel — limited analysis', channel: 'brakePressure' });
  }

  // ── RPM channel ──────────────────────────────────────────────────

  const rpm = matrix.row('rpm');
  if (rpm) {
    const rpmStats = channelStats(rpm);
    if (rpmStats.max > MAX_RPM) {
      issues.push({ severity: 'error', code: 'rpm-too-high', message: `RPM max ${rpmStats.max.toFixed(0)} exceeds ${MAX_RPM}`, channel: 'rpm' });
    } else if (!carBarelyMoved) {
      if (isNoSignal(rpmStats)) {
        issues.push({ severity: 'warning', code: 'rpm-no-signal', message: 'RPM channel exists but is all-zero — engine sensor not logged or CAN not connected', channel: 'rpm' });
      } else if (speedStats.max > 100 && rpmStats.max < 500) {
        issues.push({ severity: 'warning', code: 'rpm-too-low', message: `Car reaches ${speedStats.max.toFixed(0)} km/h but RPM max only ${rpmStats.max.toFixed(0)}`, channel: 'rpm' });
      } else if (speedStats.stddev > 10 && rpmStats.stddev < 10) {
        issues.push({ severity: 'warning', code: 'rpm-no-variation', message: 'Speed varies but RPM is constant — channel mapping error', channel: 'rpm' });
      }
    }
  }

  // ── Steering channel ─────────────────────────────────────────────

  const steer = matrix.row('steering');
  if (steer) {
    const stStats = channelStats(steer);
    if (Math.abs(stStats.max) > 900 || Math.abs(stStats.min) > 900) {
      issues.push({ severity: 'warning', code: 'steering-extreme', message: `Steering range [${stStats.min.toFixed(0)}, ${stStats.max.toFixed(0)}]° seems extreme`, channel: 'steering' });
    } else if (!carBarelyMoved) {
      if (isNoSignal(stStats)) {
        issues.push({ severity: 'warning', code: 'steering-no-signal', message: 'Steering channel exists but is all-zero — sensor not logged or CAN not connected', channel: 'steering' });
      } else if (speedStats.max > 100 && stStats.stddev < 0.1) {
        issues.push({ severity: 'warning', code: 'steering-no-variation', message: 'Car is driving but steering never moves — channel mapping error', channel: 'steering' });
      }
    }
  }

  // ── Gear channel ─────────────────────────────────────────────────

  const gear = matrix.row('gear');
  if (gear) {
    const gStats = channelStats(gear);
    if (gStats.max > 10) {
      issues.push({ severity: 'error', code: 'gear-too-high', message: `Max gear ${gStats.max} — no car has 10+ gears`, channel: 'gear' });
    }
    if (gStats.min < -2) {
      issues.push({ severity: 'error', code: 'gear-too-low', message: `Min gear ${gStats.min}`, channel: 'gear' });
    }
  }

  // ── GPS channels ─────────────────────────────────────────────────

  if (session.has.gps) {
    const lat = matrix.row('gpsLat')!;
    const lon = matrix.row('gpsLon')!;
    const latStats = channelStats(lat);
    const lonStats = channelStats(lon);

    if (latStats.max > 90 || latStats.min < -90) {
      issues.push({ severity: 'error', code: 'gps-lat-range', message: `GPS latitude [${latStats.min.toFixed(2)}, ${latStats.max.toFixed(2)}] outside ±90°`, channel: 'gpsLat' });
    }
    if (lonStats.max > 180 || lonStats.min < -180) {
      issues.push({ severity: 'error', code: 'gps-lon-range', message: `GPS longitude [${lonStats.min.toFixed(2)}, ${lonStats.max.toFixed(2)}] outside ±180°`, channel: 'gpsLon' });
    }

    // GPS should show movement if the car was actually moving
    if (!carBarelyMoved && speedStats.max > 50 && latStats.stddev < 0.00001 && lonStats.stddev < 0.00001) {
      const allZero = isNoSignal(latStats) && isNoSignal(lonStats);
      issues.push({
        severity: 'warning',
        code: allZero ? 'gps-empty' : 'gps-no-movement',
        message: allZero
          ? 'GPS lat/lon channels exist but are all-zero — coordinates likely stripped from export'
          : 'Car is moving but GPS coordinates are static — frozen sensor',
        channel: 'gpsLat',
      });
    }
  }

  // ── G-force channels ─────────────────────────────────────────────

  for (const [ch, label] of [['gLong', 'Longitudinal G'], ['gLat', 'Lateral G']] as const) {
    const row = matrix.row(ch);
    if (!row) continue;
    const stats = channelStats(row);
    if (Math.abs(stats.max) > MAX_G_FORCE || Math.abs(stats.min) > MAX_G_FORCE) {
      issues.push({ severity: 'error', code: `${ch}-extreme`, message: `${label} [${stats.min.toFixed(1)}, ${stats.max.toFixed(1)}]G — sensor reading corrupt`, channel: ch });
    }
  }

  // ── Lap checks ───────────────────────────────────────────────────

  if (session.lapCount === 0) {
    issues.push({ severity: 'warning', code: 'no-laps', message: 'No laps detected' });
  }

  const isSingleLapSession = session.lapCount === 1;

  for (const lap of session.laps) {
    const lapSecs = lap.lapTime / 1000;
    const isTimedLap = lap.kind === 'flying' || lap.kind === 'first-flying';

    // Lap time too long. For single-lap sessions, this is informational
    // (it's a free-practice run, not a misdetection) and shouldn't warn.
    if (lapSecs > MAX_LAP_TIME_S && isTimedLap && !isSingleLapSession) {
      issues.push({ severity: 'warning', code: 'lap-too-long', message: `${lap.displayLabel} is ${formatDuration(lapSecs)} — exceeds 9-min ceiling for any real circuit`, channel: 'lap' });
    }

    // Timed laps should be 1-9 minutes for any real circuit.
    // <60s is a parser/classification bug (except karts, which are still 30s+)
    if (lapSecs < 60 && isTimedLap && !carBarelyMoved) {
      issues.push({
        severity: lapSecs < 30 ? 'error' : 'warning',
        code: 'lap-too-short',
        message: `${lap.displayLabel} is ${lapSecs.toFixed(1)}s — ${lapSecs < 30 ? 'definitely' : 'probably'} not a real lap`,
        channel: 'lap',
      });
    }

    // Lap distance sanity (shortest real track ~1km, longest ~25km).
    // Suppress for single-lap sessions and stationary stints — both are
    // expected to fall outside the "real lap" range.
    if (lap.totalDistance > 0 && !carBarelyMoved && !isSingleLapSession) {
      if (lap.totalDistance < MIN_FLYING_LAP_DISTANCE_M && isTimedLap) {
        issues.push({ severity: 'warning', code: 'lap-short-distance', message: `${lap.displayLabel} distance ${lap.totalDistance.toFixed(0)}m — seems short for a track lap` });
      }
      if (lap.totalDistance > MAX_TRACK_LENGTH_M) {
        issues.push({ severity: 'error', code: 'lap-long-distance', message: `${lap.displayLabel} distance ${(lap.totalDistance/1000).toFixed(1)}km — no track is 30km+` });
      }
    }

    // Zero-duration lap
    if (lapSecs <= 0) {
      issues.push({ severity: 'error', code: 'lap-zero-time', message: `${lap.displayLabel} has zero or negative lap time` });
    }
  }

  // Timed lap consistency — all timed laps on the same track should be within 3x of each other
  const timedLaps = session.timedLaps();
  if (timedLaps.length >= 3) {
    const times = timedLaps.map(l => l.lapTime / 1000);
    const median = times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
    for (const lap of timedLaps) {
      const ratio = (lap.lapTime / 1000) / median;
      if (ratio > LAP_TIME_OUTLIER_RATIO || ratio < 1 / LAP_TIME_OUTLIER_RATIO) {
        issues.push({ severity: 'warning', code: 'lap-time-outlier', message: `${lap.displayLabel} time ${formatDuration(lap.lapTime/1000)} is ${ratio.toFixed(1)}x the median — possible misdetection` });
      }
    }
  }

  // ── Wheel speed consistency ──────────────────────────────────────

  if (session.has.wheelSpeeds) {
    const fl = matrix.row('wheelSpeedFL')!;
    const fr = matrix.row('wheelSpeedFR')!;
    const rl = matrix.row('wheelSpeedRL')!;
    const rr = matrix.row('wheelSpeedRR')!;

    for (const [row, name] of [[fl, 'FL'], [fr, 'FR'], [rl, 'RL'], [rr, 'RR']] as const) {
      const stats = channelStats(row);
      if (stats.max > speedStats.max * 2 && stats.max > 100) {
        issues.push({ severity: 'warning', code: `wheel-speed-${name.toLowerCase()}-high`, message: `Wheel speed ${name} max ${stats.max.toFixed(0)} is >2x vehicle speed ${speedStats.max.toFixed(0)}`, channel: `wheelSpeed${name}` });
      }
    }
  }

  // ── Tire pressure sanity ─────────────────────────────────────────

  if (session.has.tirePressures) {
    for (const corner of ['FL', 'FR', 'RL', 'RR'] as const) {
      const row = matrix.row(`tirePressure${corner}`);
      if (!row) continue;
      const stats = channelStats(row);
      if (stats.max > 10) {
        issues.push({ severity: 'warning', code: `tire-pressure-${corner.toLowerCase()}-high`, message: `Tire pressure ${corner} max ${stats.max.toFixed(1)} bar — may be in wrong units`, channel: `tirePressure${corner}` });
      }
    }
  }

  // ── Sentinel / garbage values ───────────────────────────────────
  // Some PDS files have channels mapped to wrong data producing extreme
  // sentinel values. Flag any channel with values outside ±50000.
  for (const chName of ['brakePressure', 'tirePressureFL', 'tirePressureFR', 'tirePressureRL', 'tirePressureRR',
    'tireTempFL', 'tireTempFR', 'tireTempRL', 'tireTempRR']) {
    const row = matrix.row(chName);
    if (!row) continue;
    let extremes = 0;
    for (let i = 0; i < row.length; i++) {
      if (isFinite(row[i]!) && (row[i]! > 50000 || row[i]! < -200)) extremes++;
    }
    if (extremes > 0) {
      issues.push({
        severity: 'warning',
        code: `${chName}-extreme-values`,
        message: `${chName} has ${extremes} extreme values (>50000 or <-200) — possible channel mapping error`,
        channel: chName,
      });
    }
  }

  // ── Distance channel ─────────────────────────────────────────────

  const dist = matrix.channels[CH_DISTANCE];
  const totalDist = dist[dist.length - 1]! - dist[0]!;
  if (totalDist < 0 && session.totalDuration > 30) {
    issues.push({ severity: 'error', code: 'distance-negative', message: 'Total distance is negative — distance channel runs backwards', channel: 'distance' });
  }

  // At 300 km/h for the entire session = max theoretical distance
  const maxTheoreticalDist = (300 / 3.6) * session.totalDuration;
  if (totalDist > maxTheoreticalDist * 1.5) {
    issues.push({ severity: 'error', code: 'distance-excessive', message: `Total distance ${(totalDist/1000).toFixed(1)}km exceeds what's possible at 300km/h for ${session.totalDuration.toFixed(0)}s`, channel: 'distance' });
  }

  return issues;
}

// ── Helpers ──────────────────────────────────────────────────────────

interface ChannelStatistics {
  min: number;
  max: number;
  mean: number;
  stddev: number;
  nanFrac: number;
  zeroFrac: number;
}

/**
 * Returns true if the channel contains no usable signal: every finite sample
 * is exactly zero. This catches the common case of a CAN channel that's been
 * declared in the file header but never actually populated (e.g. ERA_VBVD
 * recordings without CAN bus connected, or PDS exports with GPS stripped).
 */
function isNoSignal(stats: ChannelStatistics): boolean {
  return stats.min === 0 && stats.max === 0 && stats.zeroFrac > 0.99;
}

function channelStats(data: Float64Array): ChannelStatistics {
  let min = Infinity, max = -Infinity, sum = 0, sumSq = 0;
  let nanCount = 0, zeroCount = 0, n = 0;

  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (!isFinite(v)) { nanCount++; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
    if (v === 0) zeroCount++;
    n++;
  }

  const mean = n > 0 ? sum / n : 0;
  const variance = n > 0 ? (sumSq / n - mean * mean) : 0;

  return {
    min: n > 0 ? min : 0,
    max: n > 0 ? max : 0,
    mean,
    stddev: Math.sqrt(Math.max(0, variance)),
    nanFrac: data.length > 0 ? nanCount / data.length : 0,
    zeroFrac: data.length > 0 ? zeroCount / data.length : 0,
  };
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
