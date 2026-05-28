import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseVbo } from '../parsers/vbo';
import { LapKind, type SessionFormat } from '../types';
import type { Session } from '../session';

const FIXTURES = join(__dirname, '../../fixtures');

type FixtureCase = {
  format: SessionFormat;
  file: string;
  minChannels: number;
  requiresGps?: boolean;
};

const FIXTURE_CASES: FixtureCase[] = [
  // Keep only public/shareable telemetry fixtures in the repo. MoTeC and PDS
  // coverage is exercised by synthetic cross-format abstraction tests; private
  // fixture suites can still be run locally with `pnpm test:fixtures`.
  { format: 'vbo', file: 'vbo/25IT04_RdAm_PT2_Run01_RD.vbo', minChannels: 25, requiresGps: true },
];

async function loadFixture(testCase: FixtureCase): Promise<Session> {
  const path = join(FIXTURES, testCase.file);
  const data = new Uint8Array(readFileSync(path));
  expect(testCase.format).toBe('vbo');
  return parseVbo(data, path);
}

function assertFiniteRow(session: Session, channelName: string): Float64Array {
  const row = session.channelOrThrow(channelName);
  expect(row.length).toBe(session.matrix.sampleCount);
  for (let i = 0; i < row.length; i++) {
    expect(Number.isFinite(row[i])).toBe(true);
  }
  return row;
}

function minMax(row: Float64Array): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const value of row) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

function assertMonotonic(row: Float64Array, tolerance = 1e-9): void {
  for (let i = 1; i < row.length; i++) {
    expect(row[i]! + tolerance).toBeGreaterThanOrEqual(row[i - 1]!);
  }
}

function assertAbstractSession(session: Session, testCase: FixtureCase): void {
  expect(session.format).toBe(testCase.format);
  expect(session.id).toHaveLength(16);
  expect(session.sampleRate).toBeGreaterThan(0);
  expect(session.totalDuration).toBeGreaterThan(0);
  expect(session.totalDistance).toBeGreaterThan(0);
  expect(session.lapCount).toBeGreaterThan(0);
  expect(session.channelNames().length).toBeGreaterThanOrEqual(testCase.minChannels);

  // The whole point of the abstraction: every format exposes the same required
  // canonical channels with the same normalized engineering units.
  expect(session.hasChannel('time')).toBe(true);
  expect(session.hasChannel('distance')).toBe(true);
  expect(session.hasChannel('trackPosition')).toBe(true);
  expect(session.hasChannel('speed')).toBe(true);
  expect(session.hasChannel('throttle')).toBe(true);
  expect(session.channelInfo('time')).toMatchObject({ name: 'time', unit: 's', sampleRate: session.sampleRate });
  expect(session.channelInfo('distance')).toMatchObject({ name: 'distance', unit: 'm' });
  expect(session.channelInfo('trackPosition')).toMatchObject({ name: 'trackPosition', unit: 'ratio' });
  expect(session.channelInfo('speed')).toMatchObject({ name: 'speed', unit: 'km/h', required: true });
  expect(session.channelInfo('throttle')).toMatchObject({ name: 'throttle', unit: 'ratio', required: true });

  // Session accessors are aliases over the matrix, not copies.
  expect(session.channel('speed')).toBe(session.matrix.row('speed'));
  expect(session.matrix.channel('throttle')).toBe(session.channel('throttle'));
  expect(() => session.channelOrThrow('__missing__')).toThrow('Channel not found: __missing__');

  const time = assertFiniteRow(session, 'time');
  const distance = assertFiniteRow(session, 'distance');
  const trackPosition = assertFiniteRow(session, 'trackPosition');
  const speed = assertFiniteRow(session, 'speed');
  const throttle = assertFiniteRow(session, 'throttle');

  assertMonotonic(time);
  assertMonotonic(distance, 1e-3);

  const speedRange = minMax(speed);
  expect(speedRange.min).toBeGreaterThanOrEqual(-1);
  expect(speedRange.max).toBeGreaterThan(20);
  expect(speedRange.max).toBeLessThan(400);

  const throttleRange = minMax(throttle);
  expect(throttleRange.min).toBeGreaterThanOrEqual(-0.25);
  expect(throttleRange.max).toBeGreaterThan(0.05);
  expect(throttleRange.max).toBeLessThan(2.0);

  const trackRange = minMax(trackPosition);
  expect(trackRange.min).toBeGreaterThanOrEqual(-1e-6);
  expect(trackRange.max).toBeLessThanOrEqual(1.001);

  if (testCase.requiresGps) {
    expect(session.has.gps).toBe(true);
    expect(session.channelInfo('gpsLat')).toMatchObject({ unit: 'deg' });
    expect(session.channelInfo('gpsLon')).toMatchObject({ unit: 'deg' });
    const latRange = minMax(assertFiniteRow(session, 'gpsLat'));
    const lonRange = minMax(assertFiniteRow(session, 'gpsLon'));
    expect(Math.max(Math.abs(latRange.min), Math.abs(latRange.max))).toBeLessThanOrEqual(90);
    expect(Math.max(Math.abs(lonRange.min), Math.abs(lonRange.max))).toBeLessThanOrEqual(180);
  }

  if (session.has.rpm) expect(session.channelInfo('rpm')).toMatchObject({ unit: 'rpm' });
  if (session.has.gear) expect(session.channelInfo('gear')).toMatchObject({ unit: 'gear' });
  if (session.has.brakePressure) expect(session.channelInfo('brakePressure')).toMatchObject({ unit: 'bar' });
  if (session.has.steering) expect(session.channelInfo('steering')).toMatchObject({ unit: 'deg' });
  if (session.has.gLat) expect(session.channelInfo('gLat')).toMatchObject({ unit: 'g' });
  if (session.has.yawRate) expect(session.channelInfo('yawRate')).toMatchObject({ unit: 'deg/s' });
}

function assertAbstractLapApi(session: Session): void {
  const lap = session.timedLaps()[0] ?? session.lap(0);
  expect(Object.values(LapKind)).toContain(lap.kind);
  expect(lap.sampleRate).toBe(session.sampleRate);
  expect(lap.sampleCount).toBeGreaterThan(0);
  expect(lap.lapTime).toBeGreaterThan(0);
  expect(lap.totalDistance).toBeGreaterThanOrEqual(0);

  expect(lap.hasChannel('speed')).toBe(true);
  expect(lap.channelNames()).toEqual(expect.arrayContaining(['time', 'distance', 'trackPosition', 'speed', 'throttle']));
  expect(lap.channelInfo('speed')).toMatchObject({ unit: 'km/h', sampleCount: lap.sampleCount });

  const lapSpeed = lap.channelOrThrow('speed');
  expect(lapSpeed.length).toBe(lap.sampleCount);
  expect(lapSpeed.buffer).toBe(session.channelOrThrow('speed').buffer);
  expect(lap.samples.channel('speed')!.buffer).toBe(session.channelOrThrow('speed').buffer);

  const mid = lap.at(0.5);
  expect(mid.has('speed')).toBe(true);
  expect(mid.get('speed')).toBeCloseTo(mid.speed, 8);
  expect(mid.get('throttle')).toBeCloseTo(mid.throttle, 8);
  expect(mid.get('__missing__')).toBeNull();
  expect(mid.getOr('__missing__', -123)).toBe(-123);

  const object = mid.toObject(['speed', 'throttle', 'rpm', '__missing__']);
  expect(object.speed).toBeCloseTo(mid.speed, 8);
  expect(object.throttle).toBeCloseTo(mid.throttle, 8);
  expect(object.rpm).toBe(mid.rpm);
  expect(object.__missing__).toBeNull();

  const trace = lap.channelAtPositions('speed', 64);
  expect(trace.length).toBe(64);
  for (const value of trace) expect(Number.isFinite(value)).toBe(true);

  const byTime = lap.atTime(Math.min(1, lap.lapTime / 2000));
  expect(byTime.get('speed')).toBeCloseTo(byTime.speed, 8);
}

describe('real fixture files through the normalized abstraction', () => {
  for (const testCase of FIXTURE_CASES) {
    it(`${testCase.file} parses into a coherent canonical Session/Lap/LapSample API`, async () => {
      const session = await loadFixture(testCase);
      assertAbstractSession(session, testCase);
      assertAbstractLapApi(session);
    });
  }
});
