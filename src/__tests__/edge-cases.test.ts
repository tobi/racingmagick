/**
 * Edge case tests: error conditions, malformed input, boundary cases.
 * These tests verify the library is "bulletproof" against bad data.
 */

import { describe, it, expect } from 'vitest';
import { ChannelMatrix, buildChannelMatrix } from '../channel-matrix';
import { Session } from '../session';
import { ParseError, LapKind, CH_TIME, CH_SPEED, CH_DISTANCE, CH_THROTTLE, CH_TRACK_POSITION } from '../types';
import type { SessionData, RawChannel, LapBoundary, SessionWarning } from '../types';
import { classifyLap, buildLaps, computeSectorTimes } from '../lap-classification';
import { resolveAllChannels, resolveThrottleChannels, resolveChannel, toRatio } from '../channels';
import { Lap } from '../lap';
import { LapSample } from '../lap-sample';
import { lint } from '../lint';
import {
  filterGpsForArcLength, computeGpsArcLength, detectCoordinateSystem,
  convertCoordinates, integrateSpeed, haversine, smoothGps,
} from '../gps';
import { CUSTOM_CHANNEL_PREFIX } from '../constants';

// ── Helpers ──────────────────────────────────────────────────────────

function makeSessionData(overrides: Partial<SessionData> = {}): SessionData {
  const speedSamples = new Float64Array(1000);
  const throttleSamples = new Float64Array(1000);
  for (let i = 0; i < 1000; i++) {
    speedSamples[i] = 50 + 50 * Math.sin(i / 100); // 0-100 km/h
    throttleSamples[i] = 0.5 + 0.4 * Math.sin(i / 80); // 0.1-0.9
  }

  return {
    format: 'motec',
    driver: 'Test Driver',
    vehicle: 'Test Car',
    track: 'Test Track',
    date: new Date('2024-01-01T12:00:00'),
    rawChannels: [
      { name: 'Ground Speed', unit: 'km/h', frequency: 100, samples: speedSamples },
      { name: 'Driver Throttle Pos', unit: '%', frequency: 100, samples: throttleSamples },
    ],
    lapBoundaries: [
      { timeSeconds: 0 },
      { timeSeconds: 5 },
      { timeSeconds: 9.99 },
    ],
    circuit: null,
    warnings: [],
    fileURL: 'test.ld',
    ...overrides,
  };
}

// ── ParseError context ──────────────────────────────────────────────

describe('ParseError', () => {
  it('carries format and context', () => {
    const err = new ParseError('test error', 'motec', { channel: 'speed', offset: 42, fileURL: 'test.ld' });
    expect(err.message).toBe('test error');
    expect(err.format).toBe('motec');
    expect(err.context?.channel).toBe('speed');
    expect(err.context?.offset).toBe(42);
    expect(err.context?.fileURL).toBe('test.ld');
    expect(err.name).toBe('ParseError');
  });

  it('works without context', () => {
    const err = new ParseError('no context');
    expect(err.context).toBeUndefined();
    expect(err.format).toBeUndefined();
  });
});

// ── Session construction edge cases ─────────────────────────────────

describe('Session construction', () => {
  it('throws when no speed channel exists', () => {
    const throttle = new Float64Array(100).fill(0.5);
    expect(() => new Session({
      format: 'motec',
      driver: 'X',
      vehicle: 'X',
      track: 'X',
      date: new Date(),
      rawChannels: [{ name: 'Throttle Pedal', unit: '%', frequency: 100, samples: throttle }],
      lapBoundaries: [],
      circuit: null,
      warnings: [],
      fileURL: 'test.ld',
    })).toThrow(ParseError);
  });

  it('throws when no throttle channel exists', () => {
    const speed = new Float64Array(100).fill(80);
    expect(() => new Session({
      format: 'motec',
      driver: 'X',
      vehicle: 'X',
      track: 'X',
      date: new Date(),
      rawChannels: [{ name: 'Ground Speed', unit: 'km/h', frequency: 100, samples: speed }],
      lapBoundaries: [],
      circuit: null,
      warnings: [],
      fileURL: 'test.ld',
    })).toThrow(ParseError);
  });

  it('produces session with minimal valid data', () => {
    const session = new Session(makeSessionData({ lapBoundaries: [] }));
    expect(session.lapCount).toBe(1); // single whole-session lap
    expect(session.sampleRate).toBeGreaterThan(0);
    expect(session.totalDuration).toBeGreaterThan(0);
  });

  it('warns when distance channel is missing (integrates from speed)', () => {
    const session = new Session(makeSessionData());
    const distWarning = session.warnings.find(w => w.code === 'distance-channel-missing');
    expect(distWarning).toBeDefined();
    expect(session.totalDistance).toBeGreaterThan(0);
  });

  it('prefixes custom channels to avoid collision with canonical names', () => {
    const speed = new Float64Array(100).fill(80);
    const throttle = new Float64Array(100).fill(0.5);
    const customSpeed = new Float64Array(100).fill(42);

    const session = new Session({
      format: 'motec',
      driver: 'X',
      vehicle: 'X',
      track: 'X',
      date: new Date(),
      rawChannels: [
        { name: 'Ground Speed', unit: 'km/h', frequency: 100, samples: speed },
        { name: 'Driver Throttle Pos', unit: '%', frequency: 100, samples: throttle },
        { name: 'speed', unit: 'custom', frequency: 100, samples: customSpeed },
      ],
      lapBoundaries: [],
      circuit: null,
      warnings: [],
      fileURL: 'test.ld',
    });

    // The canonical 'speed' channel should exist and come from 'Ground Speed'
    expect(session.matrix.has('speed')).toBe(true);
    // The custom 'speed' channel should be prefixed
    expect(session.matrix.has(CUSTOM_CHANNEL_PREFIX + 'speed')).toBe(true);
  });
});

// ── ChannelMatrix edge cases ────────────────────────────────────────

describe('ChannelMatrix edge cases', () => {
  it('throws on empty inputs', () => {
    expect(() => buildChannelMatrix([])).toThrow('No channels provided');
  });

  it('throws on zero/negative frequency', () => {
    expect(() => buildChannelMatrix([
      { name: 'speed', frequency: 0, samples: new Float64Array(10) },
    ])).toThrow('Invalid target frequency');
  });

  it('handles single-sample channel', () => {
    const matrix = buildChannelMatrix([
      { name: 'speed', frequency: 100, samples: new Float64Array([42]) },
    ]);
    expect(matrix.sampleCount).toBe(1);
  });

  it('resamples heterogeneous frequencies', () => {
    const fast = new Float64Array(200);
    const slow = new Float64Array(10);
    for (let i = 0; i < 200; i++) fast[i] = i;
    for (let i = 0; i < 10; i++) slow[i] = i * 20;

    const matrix = buildChannelMatrix([
      { name: 'speed', frequency: 100, samples: fast },
      { name: 'rpm', frequency: 5, samples: slow },
    ]);
    // All channels should have same sample count
    for (const ch of matrix.channels) {
      expect(ch.length).toBe(matrix.sampleCount);
    }
  });
});

// ── Channel resolution edge cases ───────────────────────────────────

describe('Channel resolution edge cases', () => {
  it('resolves with mixed case and punctuation', () => {
    const result = resolveChannel('Driver_Throttle_Pos');
    expect(result?.canonical).toBe('throttle');
  });

  it('returns undefined for unknown channel', () => {
    expect(resolveChannel('XYZ_totally_unknown_channel')).toBeUndefined();
  });

  it('toRatio handles empty unit with high values', () => {
    // Empty unit + value > 5 → divide by 100
    expect(toRatio(50, '')).toBeCloseTo(0.5);
    expect(toRatio(100, '')).toBeCloseTo(1.0);
  });

  it('toRatio does NOT divide small values with empty unit', () => {
    // Values ≤ 5 with empty unit should NOT be divided
    expect(toRatio(0.8, '')).toBeCloseTo(0.8);
    expect(toRatio(1.0, '')).toBeCloseTo(1.0);
  });

  it('toRatio handles percentage unit', () => {
    expect(toRatio(50, '%')).toBeCloseTo(0.5);
    expect(toRatio(100, 'pct')).toBeCloseTo(1.0);
    expect(toRatio(75, 'percent')).toBeCloseTo(0.75);
  });

  it('resolveThrottleChannels remaps when only actual exists', () => {
    const resolved = new Map<string, { rawIndex: number; transform: null }>();
    resolved.set('throttleActual', { rawIndex: 0, transform: null });

    const result = resolveThrottleChannels(resolved);
    expect(result.remapped).toBe(true);
    expect(result.warning).toBeTruthy();
    expect(resolved.has('throttle')).toBe(true);
    expect(resolved.has('throttleActual')).toBe(false);
  });
});

// ── Lap classification edge cases ───────────────────────────────────

describe('Lap classification edge cases', () => {
  function makeMatrix(speedValues: number[], sampleRate = 100): ChannelMatrix {
    const n = speedValues.length;
    return buildChannelMatrix([
      { name: 'speed', frequency: sampleRate, samples: new Float64Array(speedValues) },
      { name: 'throttle', frequency: sampleRate, samples: new Float64Array(n).fill(0.5) },
    ]);
  }

  it('classifies zero-length lap as Slow', () => {
    const matrix = makeMatrix([100, 100, 100]);
    const kind = classifyLap({ startIdx: 1, endIdx: 1 }, matrix, null);
    expect(kind).toBe(LapKind.Slow);
  });

  it('classifies short fragment (< 30s) as Slow', () => {
    // 20 samples at 100Hz = 0.2s
    const matrix = makeMatrix(new Array(20).fill(150));
    const kind = classifyLap({ startIdx: 0, endIdx: 20 }, matrix, null);
    expect(kind).toBe(LapKind.Slow);
  });

  it('classifies out-lap correctly', () => {
    // Starts slow, ends fast. 4000 samples at 100Hz = 40s (> MIN_LAP_DURATION_S)
    const speeds = new Array(4000).fill(0).map((_, i) => i < 2000 ? 30 : 150);
    const matrix = makeMatrix(speeds);
    const kind = classifyLap({ startIdx: 0, endIdx: 4000 }, matrix, null);
    expect(kind).toBe(LapKind.OutLap);
  });

  it('buildLaps handles empty boundaries', () => {
    const matrix = makeMatrix(new Array(5000).fill(100));
    const laps = buildLaps(matrix, [], 'distance');
    expect(laps.length).toBe(1);
    expect(laps[0].kind).toBe(LapKind.Flying);
  });

  it('buildLaps handles single boundary', () => {
    const matrix = makeMatrix(new Array(5000).fill(100));
    const laps = buildLaps(matrix, [{ timeSeconds: 5 }], 'distance');
    expect(laps.length).toBe(1); // < 2 boundaries → whole session as one lap
  });
});

// ── GPS edge cases ──────────────────────────────────────────────────

describe('GPS edge cases', () => {
  it('haversine returns 0 for same point', () => {
    expect(haversine(40.0, -74.0, 40.0, -74.0)).toBe(0);
  });

  it('haversine returns reasonable distances', () => {
    // ~111km per degree of latitude
    const dist = haversine(40.0, -74.0, 41.0, -74.0);
    expect(dist).toBeGreaterThan(110000);
    expect(dist).toBeLessThan(112000);
  });

  it('filterGpsForArcLength handles all-zero GPS with low satellites', () => {
    const n = 100;
    const lat = new Float64Array(n);
    const lon = new Float64Array(n);
    const speed = new Float64Array(n).fill(100);
    const sats = new Float64Array(n).fill(2); // low satellite count → all invalid
    const result = filterGpsForArcLength(lat, lon, speed, 100, sats);
    expect(result.invalidCount).toBeGreaterThan(0);
  });

  it('filterGpsForArcLength flags low satellite count', () => {
    const n = 50;
    const lat = new Float64Array(n).fill(40.0);
    const lon = new Float64Array(n).fill(-74.0);
    const speed = new Float64Array(n).fill(100);
    const sats = new Float64Array(n).fill(2); // Below MIN_GPS_SATELLITES
    const result = filterGpsForArcLength(lat, lon, speed, 100, sats);
    // All samples except first should be flagged (first has no prev)
    expect(result.invalidCount).toBe(n - 1);
  });

  it('detectCoordinateSystem handles all-zero as decimal', () => {
    const lat = new Float64Array(10);
    const lon = new Float64Array(10);
    expect(detectCoordinateSystem(lat, lon)).toBe('decimal');
  });

  it('detectCoordinateSystem detects radians', () => {
    const lat = new Float64Array([0.7, 0.7, 0.7]);
    const lon = new Float64Array([1.5, 1.5, 1.5]);
    expect(detectCoordinateSystem(lat, lon)).toBe('radians');
  });

  it('integrateSpeed produces monotonically increasing distance', () => {
    const speed = new Float64Array([100, 100, 100, 100, 100]);
    const dist = integrateSpeed(speed, 100);
    for (let i = 1; i < dist.length; i++) {
      expect(dist[i]).toBeGreaterThanOrEqual(dist[i - 1]);
    }
  });

  it('integrateSpeed handles zero speed', () => {
    const speed = new Float64Array([0, 0, 0, 0, 0]);
    const dist = integrateSpeed(speed, 100);
    expect(dist[dist.length - 1]).toBe(0);
  });
});

// ── Lap interpolation edge cases ────────────────────────────────────

describe('Lap interpolation', () => {
  function makeSessionWithLap(): Session {
    return new Session(makeSessionData());
  }

  it('at() clamps to [0, 1]', () => {
    const session = makeSessionWithLap();
    const lap = session.laps[0];
    const sampleNeg = lap.at(-0.5);
    const sampleOver = lap.at(1.5);
    expect(sampleNeg.trackPosition).toBeDefined();
    expect(sampleOver.trackPosition).toBeDefined();
  });

  it('at(0) and at(1) return start and end of lap', () => {
    const session = makeSessionWithLap();
    const lap = session.laps[0];
    const start = lap.at(0);
    const end = lap.at(1);
    expect(end.time).toBeGreaterThanOrEqual(start.time);
  });

  it('interpolated sample has blended values', () => {
    const session = makeSessionWithLap();
    const lap = session.laps[0];
    const mid = lap.at(0.5);
    // The interpolated speed should be within the range of the lap
    expect(mid.speed).toBeGreaterThanOrEqual(0);
    expect(mid.speed).toBeLessThanOrEqual(110); // speedSamples max ~100
  });

  it('resample returns correct count', () => {
    const session = makeSessionWithLap();
    const lap = session.laps[0];
    const samples = lap.resample(50);
    expect(samples.length).toBe(50);
  });
});

// ── Lint edge cases ─────────────────────────────────────────────────

describe('Lint edge cases', () => {
  it('flags zero duration', () => {
    // Create a session with data that produces zero duration
    const speed = new Float64Array(1).fill(100);
    const throttle = new Float64Array(1).fill(0.5);
    const session = new Session({
      format: 'motec',
      driver: 'X',
      vehicle: 'X',
      track: 'X',
      date: new Date(),
      rawChannels: [
        { name: 'Ground Speed', unit: 'km/h', frequency: 100, samples: speed },
        { name: 'Driver Throttle Pos', unit: '%', frequency: 100, samples: throttle },
      ],
      lapBoundaries: [],
      circuit: null,
      warnings: [],
      fileURL: 'test.ld',
    });
    const issues = lint(session);
    const zeroDuration = issues.find(i => i.code === 'zero-duration');
    expect(zeroDuration).toBeDefined();
  });

  it('flags speed over max', () => {
    const n = 1000;
    const speed = new Float64Array(n).fill(450); // > MAX_VEHICLE_SPEED_KMH
    const throttle = new Float64Array(n).fill(0.5);
    const session = new Session({
      format: 'motec',
      driver: 'X',
      vehicle: 'X',
      track: 'X',
      date: new Date(),
      rawChannels: [
        { name: 'Ground Speed', unit: 'km/h', frequency: 100, samples: speed },
        { name: 'Driver Throttle Pos', unit: '%', frequency: 100, samples: throttle },
      ],
      lapBoundaries: [],
      circuit: null,
      warnings: [],
      fileURL: 'test.ld',
    });
    const issues = lint(session);
    const tooFast = issues.find(i => i.code === 'speed-too-fast');
    expect(tooFast).toBeDefined();
  });

  it('flags throttle over range', () => {
    const n = 1000;
    const speed = new Float64Array(n).fill(100);
    const throttle = new Float64Array(n).fill(200); // Raw percentage, not converted
    const session = new Session({
      format: 'motec',
      driver: 'X',
      vehicle: 'X',
      track: 'X',
      date: new Date(),
      rawChannels: [
        { name: 'Ground Speed', unit: 'km/h', frequency: 100, samples: speed },
        { name: 'APS', unit: '', frequency: 100, samples: throttle },
      ],
      lapBoundaries: [],
      circuit: null,
      warnings: [],
      fileURL: 'test.ld',
    });
    const issues = lint(session);
    const overRange = issues.find(i => i.code === 'throttle-over-range');
    expect(overRange).toBeDefined();
  });
});

// ── MoTeC parser edge cases ─────────────────────────────────────────

describe('MoTeC parser edge cases', () => {
  it('rejects file too small', async () => {
    const { parseMotec } = await import('../parsers/motec');
    const tiny = new Uint8Array(10);
    await expect(parseMotec(tiny, 'tiny.ld')).rejects.toThrow(ParseError);
  });

  it('rejects wrong magic number', async () => {
    const { parseMotec } = await import('../parsers/motec');
    const bad = new Uint8Array(0x1A0);
    bad[0] = 0xFF; // wrong magic
    await expect(parseMotec(bad, 'bad.ld')).rejects.toThrow(ParseError);
  });

  it('rejects file with valid header but no channels', async () => {
    const { parseMotec } = await import('../parsers/motec');
    const buf = new Uint8Array(0x1A0);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x40, true); // correct magic
    view.setUint32(0x08, 0, true); // channelMetaPtr = 0 (no channels)
    await expect(parseMotec(buf, 'empty.ld')).rejects.toThrow(ParseError);
  });
});

// ── PDS parser edge cases ───────────────────────────────────────────

describe('PDS parser edge cases', () => {
  it('rejects file too small', async () => {
    const { parsePds } = await import('../parsers/pds');
    const tiny = new Uint8Array(10);
    expect(() => parsePds(tiny, 'tiny.pds')).toThrow(ParseError);
  });
});

// ── VBO parser edge cases ───────────────────────────────────────────

describe('VBO parser edge cases', () => {
  it('rejects empty file', async () => {
    const { parseVbo } = await import('../parsers/vbo');
    const empty = new Uint8Array(0);
    expect(() => parseVbo(empty, 'empty.vbo')).toThrow();
  });
});

// ── Sector time computation ─────────────────────────────────────────

describe('computeSectorTimes', () => {
  it('returns null when no GPS data available', () => {
    const matrix = buildChannelMatrix([
      { name: 'speed', frequency: 100, samples: new Float64Array(100).fill(100) },
      { name: 'throttle', frequency: 100, samples: new Float64Array(100).fill(0.5) },
    ]);
    const result = computeSectorTimes(matrix, 0, 100, [
      { type: 'split', name: 'S1', start: { lat: 40, lon: -74 }, end: { lat: 40.001, lon: -74 } },
    ]);
    expect(result).toBeNull();
  });

  it('returns null when no split lines exist', () => {
    const matrix = buildChannelMatrix([
      { name: 'speed', frequency: 100, samples: new Float64Array(100).fill(100) },
      { name: 'throttle', frequency: 100, samples: new Float64Array(100).fill(0.5) },
      { name: 'gpsLat', frequency: 100, samples: new Float64Array(100).fill(40) },
      { name: 'gpsLon', frequency: 100, samples: new Float64Array(100).fill(-74) },
    ]);
    const result = computeSectorTimes(matrix, 0, 100, []);
    expect(result).toBeNull();
  });
});

// ── LapSample interpolation ─────────────────────────────────────────

describe('LapSample interpolation', () => {
  it('non-interpolated sample returns exact values', () => {
    const matrix = buildChannelMatrix([
      { name: 'speed', frequency: 10, samples: new Float64Array([10, 20, 30, 40, 50]) },
      { name: 'throttle', frequency: 10, samples: new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5]) },
    ]);
    const sample = new LapSample(matrix, 2);
    expect(sample.speed).toBeCloseTo(30);
    expect(sample.throttle).toBeCloseTo(0.3);
  });

  it('interpolated sample blends between two indices', () => {
    const matrix = buildChannelMatrix([
      { name: 'speed', frequency: 10, samples: new Float64Array([10, 20, 30, 40, 50]) },
      { name: 'throttle', frequency: 10, samples: new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5]) },
    ]);
    // Interpolate 50% between index 1 (speed=20) and index 2 (speed=30)
    const sample = new LapSample(matrix, 1, 2, 0.5);
    expect(sample.speed).toBeCloseTo(25);
    expect(sample.throttle).toBeCloseTo(0.25);
  });

  it('interpolated sample with frac=0 returns lo values', () => {
    const matrix = buildChannelMatrix([
      { name: 'speed', frequency: 10, samples: new Float64Array([10, 20, 30]) },
      { name: 'throttle', frequency: 10, samples: new Float64Array([0.1, 0.2, 0.3]) },
    ]);
    const sample = new LapSample(matrix, 0, 2, 0);
    expect(sample.speed).toBeCloseTo(10);
  });

  it('optional channels return null when not present', () => {
    const matrix = buildChannelMatrix([
      { name: 'speed', frequency: 10, samples: new Float64Array([10, 20]) },
      { name: 'throttle', frequency: 10, samples: new Float64Array([0.5, 0.5]) },
    ]);
    const sample = new LapSample(matrix, 0);
    expect(sample.rpm).toBeNull();
    expect(sample.gear).toBeNull();
    expect(sample.gpsLat).toBeNull();
  });
});
