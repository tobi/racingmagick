import { describe, it, expect } from 'vitest';
import { Session } from '../session';
import { LapSample } from '../lap-sample';
import {
  canonicalChannelNames,
  getCanonicalUnit,
  getChannelDefinition,
  normalizeSpeed,
  normalizeRatio,
  normalizePressure,
  normalizeG,
  normalizeTemperature,
  normalizeSlipAngle,
  resolveAllChannels,
  toDegPerSec,
  toMeters,
  toMetersAlt,
  toMillimeters,
  toNewtons,
} from '../channels';
import type { RawChannel, SessionData, SessionFormat } from '../types';

function arr(values: number[]): Float64Array {
  return new Float64Array(values);
}

const expected = {
  speed: [0, 36, 72, 108, 144],
  throttle: [0, 0.25, 0.5, 0.75, 1],
  distance: [0, 100, 200, 300, 400],
  brakePressure: [0, 10, 20, 30, 40],
  steering: [0, 10, 20, 30, 40],
  gLat: [0, 0.5, 1, 1.5, 2],
  yawRate: [0, 30, 60, 90, 120],
  tireTempFL: [20, 40, 60, 80, 100],
  gpsAlt: [0, 10, 20, 30, 40],
};

function rawChannel(name: string, unit: string, samples: number[]): RawChannel {
  return { name, unit, frequency: 1, samples: arr(samples) };
}

function syntheticSession(format: SessionFormat, rawChannels: RawChannel[]): Session {
  const data: SessionData = {
    format,
    driver: 'Unit Tester',
    vehicle: 'Synthetic GT3',
    track: 'Abstraction Ring',
    date: new Date('2026-05-28T00:00:00Z'),
    rawChannels,
    lapBoundaries: [],
    circuit: null,
    warnings: [],
    fileURL: `synthetic.${format}`,
  };
  return new Session(data);
}

function motecLikeSession(): Session {
  return syntheticSession('motec', [
    rawChannel('Corr Speed', 'm/s', [0, 10, 20, 30, 40]),
    rawChannel('Driver Throttle Pos', '%', [0, 25, 50, 75, 100]),
    rawChannel('Lap Distance', 'ft', [0, 328.08399, 656.16798, 984.25197, 1312.33596]),
    rawChannel('Brake Pressure Front', 'psi', [0, 145.0377, 290.0754, 435.1131, 580.1508]),
    rawChannel('Steering Angle', 'rad', [0, Math.PI / 18, Math.PI / 9, Math.PI / 6, 2 * Math.PI / 9]),
    rawChannel('Combo_G', 'm/s2', [0, 4.905, 9.81, 14.715, 19.62]),
    rawChannel('Yaw Rate', 'rad/s', [0, Math.PI / 6, Math.PI / 3, Math.PI / 2, 2 * Math.PI / 3]),
    rawChannel('Tire Temp FL', '°F', [68, 104, 140, 176, 212]),
    rawChannel('GPS Altitude', 'ft', [0, 32.808399, 65.616798, 98.425197, 131.233596]),
    rawChannel('Driver Comment', '', [101, 102, 103, 104, 105]),
  ]);
}

function pdsLikeSession(): Session {
  return syntheticSession('pds', [
    rawChannel('Speed', 'km/h', expected.speed),
    rawChannel('FBWDriverTPS', 'ratio', expected.throttle),
    rawChannel('Distance', 'm', expected.distance),
    rawChannel('Brake Pressure F', 'kPa', [0, 1000, 2000, 3000, 4000]),
    rawChannel('Steer', 'deg', expected.steering),
    rawChannel('Combo G', 'g', expected.gLat),
    rawChannel('Gyro Z', 'deg/s', expected.yawRate),
    rawChannel('T Tyre FL', 'C', expected.tireTempFL),
    rawChannel('FIA_GpsAlt', 'm', expected.gpsAlt),
  ]);
}

function vboLikeSession(): Session {
  return syntheticSession('vbo', [
    rawChannel('Vehicle_Speed', 'mph', expected.speed.map((v) => v / 1.609344)),
    rawChannel('Throttle_Pedal', 'percent', [0, 25, 50, 75, 100]),
    rawChannel('Distance', 'mi', expected.distance.map((v) => v / 1609.344)),
    rawChannel('Brake_Pressure_Front', 'MPa', [0, 1, 2, 3, 4]),
    rawChannel('Steering_Angle', 'deg', expected.steering),
    rawChannel('Combo_G', 'm/s²', [0, 4.905, 9.81, 14.715, 19.62]),
    rawChannel('Gyro_Z', 'radians/s', [0, Math.PI / 6, Math.PI / 3, Math.PI / 2, 2 * Math.PI / 3]),
    rawChannel('Tyre Temp FL', 'K', expected.tireTempFL.map((v) => v + 273.15)),
    rawChannel('height', 'feet', [0, 32.808399, 65.616798, 98.425197, 131.233596]),
  ]);
}

function expectRowClose(session: Session, channel: keyof typeof expected, digits = 4): void {
  const row = session.channelOrThrow(channel);
  expect(row.length).toBe(expected[channel].length);
  for (let i = 0; i < row.length; i++) {
    expect(row[i]).toBeCloseTo(expected[channel][i]!, digits);
  }
}

describe('normalized telemetry abstraction', () => {
  it('normalizes equivalent MoTeC, PDS, and VBO channel sets into the same canonical API and units', () => {
    for (const session of [motecLikeSession(), pdsLikeSession(), vboLikeSession()]) {
      expect(session.hasChannel('speed')).toBe(true);
      expect(session.hasChannel('throttle')).toBe(true);
      expect(session.hasChannel('brakePressure')).toBe(true);
      expect(session.hasChannel('steering')).toBe(true);
      expect(session.hasChannel('gLat')).toBe(true);
      expect(session.hasChannel('yawRate')).toBe(true);
      expect(session.hasChannel('tireTempFL')).toBe(true);
      expect(session.hasChannel('gpsAlt')).toBe(true);

      for (const channel of Object.keys(expected) as Array<keyof typeof expected>) {
        expectRowClose(session, channel);
      }

      expect(session.channelInfo('speed')).toMatchObject({ name: 'speed', unit: 'km/h', sampleRate: 1, sampleCount: 5 });
      expect(session.channelInfo('throttle')).toMatchObject({ name: 'throttle', unit: 'ratio' });
      expect(session.channelInfo('brakePressure')).toMatchObject({ name: 'brakePressure', unit: 'bar' });
      expect(session.channelNames()).toEqual(expect.arrayContaining(['time', 'distance', 'trackPosition', 'speed', 'throttle']));
    }
  });

  it('provides ergonomic zero-copy access at session, lap, slice, and sample levels', () => {
    const session = motecLikeSession();
    const lap = session.lap(0);

    expect(session.channel('speed')).toBe(session.matrix.row('speed'));
    expect(() => session.channelOrThrow('unknown')).toThrow('Channel not found: unknown');

    const lapSpeed = lap.channelOrThrow('speed');
    expect(lapSpeed).toBeInstanceOf(Float64Array);
    expect(lapSpeed.buffer).toBe(session.channelOrThrow('speed').buffer);
    expect(lap.channelInfo('speed')).toMatchObject({ name: 'speed', unit: 'km/h', sampleCount: lap.sampleCount });
    expect(lap.hasChannel('missing')).toBe(false);

    const samples = lap.samples;
    expect(samples.channel('speed')!.buffer).toBe(session.channelOrThrow('speed').buffer);
    expect(samples.at(2).get('speed')).toBeCloseTo(72, 5);
    expect(samples.at(2).getOr('notRecorded', -1)).toBe(-1);
    expect(samples.at(2).toObject(['speed', 'throttle', 'notRecorded'])).toEqual({
      speed: 72,
      throttle: 0.5,
      notRecorded: null,
    });
  });

  it('interpolated LapSample supports both typed getters and the generic get() API', () => {
    const matrix = motecLikeSession().matrix;
    const sample = new LapSample(matrix, 1, 2, 0.5);

    expect(sample.speed).toBeCloseTo(54, 5);
    expect(sample.get('speed')).toBeCloseTo(sample.speed, 5);
    expect(sample.throttle).toBeCloseTo(0.375, 5);
    expect(sample.get('throttle')).toBeCloseTo(sample.throttle, 5);
    expect(sample.tireTempFL).toBeCloseTo(50, 5);
    expect(sample.get('tireTempFL')).toBeCloseTo(50, 5);
    expect(sample.get('missing')).toBeNull();
    expect(sample.has('speed')).toBe(true);
  });
});

describe('unit normalization helpers and channel catalog', () => {
  it('covers common motorsport unit spellings across telemetry vendors', () => {
    expect(normalizeSpeed(10, 'm/s')).toBeCloseTo(36, 6);
    expect(normalizeSpeed(60, 'mph')).toBeCloseTo(96.56064, 6);
    expect(normalizeSpeed(10, 'kt')).toBeCloseTo(18.52, 6);

    expect(normalizeRatio(75, 'percent')).toBeCloseTo(0.75, 6);
    expect(normalizeRatio(0.42, 'ratio')).toBeCloseTo(0.42, 6);
    expect(normalizeRatio(80, '')).toBeCloseTo(0.8, 6);
    expect(normalizeRatio(1.2, '')).toBeCloseTo(1.2, 6);

    expect(normalizePressure(100, 'psi')).toBeCloseTo(6.89476, 5);
    expect(normalizePressure(250, 'kPa')).toBeCloseTo(2.5, 6);
    expect(normalizePressure(1.2, 'MPa')).toBeCloseTo(12, 6);
    expect(normalizePressure(101325, 'Pa')).toBeCloseTo(1.01325, 6);

    expect(normalizeG(9.81, 'm/s²')).toBeCloseTo(1, 6);
    expect(normalizeSlipAngle(Math.PI / 2, 'rad')).toBeCloseTo(90, 6);
    expect(toDegPerSec(Math.PI, 'rad/s')).toBeCloseTo(180, 6);
    expect(toMeters(1, 'mi')).toBeCloseTo(1609.344, 6);
    expect(toMeters(3, 'ft')).toBeCloseTo(0.9144, 6);
    expect(toMetersAlt(100, 'feet')).toBeCloseTo(30.48, 6);
    expect(toMillimeters(2, 'in')).toBeCloseTo(50.8, 6);
    expect(toMillimeters(0.025, 'm')).toBeCloseTo(25, 6);
    expect(toNewtons(100, 'lbf')).toBeCloseTo(444.8221615, 6);
    expect(toNewtons(2, 'kN')).toBeCloseTo(2000, 6);
    expect(normalizeTemperature(212, 'fahrenheit')).toBeCloseTo(100, 6);
    expect(normalizeTemperature(373.15, 'kelvin')).toBeCloseTo(100, 6);
  });

  it('documents canonical names, units, and aliases for public consumers', () => {
    expect(canonicalChannelNames()).toContain('speed');
    expect(getCanonicalUnit('speed')).toBe('km/h');
    expect(getCanonicalUnit('throttle')).toBe('ratio');
    expect(getCanonicalUnit('brakePressure')).toBe('bar');
    expect(getChannelDefinition('speed')).toMatchObject({
      name: 'speed',
      unit: 'km/h',
      required: true,
      aliases: expect.arrayContaining(['corr speed', 'vehicle speed', 'speed']),
    });
    expect(getChannelDefinition('tireTempFL')).toMatchObject({ unit: '°C', required: false });
    expect(getChannelDefinition('customChannel')).toBeUndefined();
  });

  it('resolves channel priorities deterministically before normalization is applied', () => {
    const resolved = resolveAllChannels([
      { name: 'Speed', unit: 'mph', frequency: 1, samples: arr([1]) },
      { name: 'Corr Speed', unit: 'm/s', frequency: 1, samples: arr([1]) },
      { name: 'TPS', unit: '%', frequency: 1, samples: arr([1]) },
      { name: 'Driver Throttle Pos', unit: '%', frequency: 1, samples: arr([1]) },
    ]);

    expect(resolved.get('speed')?.rawIndex).toBe(1);
    expect(resolved.get('throttle')?.rawIndex).toBe(3);
  });
});
