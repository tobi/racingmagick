import { describe, it, expect } from 'vitest';
import {
  resolveChannelName,
  normalizeSpeed,
  normalizeRatio,
  normalizePressure,
  normalizeG,
  resolveThrottleChannels,
} from '../channels';

describe('resolveChannelName', () => {
  it('resolves MoTeC speed aliases', () => {
    expect(resolveChannelName('Corr Speed')).toBe('speed');
    expect(resolveChannelName('Ground Speed')).toBe('speed');
    expect(resolveChannelName('Wheel Speed AVG')).toBe('speed');
  });

  it('resolves VBO aliases', () => {
    expect(resolveChannelName('Vehicle_Speed')).toBe('speed');
    expect(resolveChannelName('Engine_Speed')).toBe('rpm');
    expect(resolveChannelName('Throttle_Pedal')).toBe('throttle');
    expect(resolveChannelName('Brake_Pressure_Front')).toBe('brakePressure');
    expect(resolveChannelName('Steering_Angle')).toBe('steering');
    expect(resolveChannelName('Car_On_Jack')).toBe('carOnJack');
    expect(resolveChannelName('Lap_Number')).toBe('lapNumber');
    expect(resolveChannelName('TC_Active')).toBe(undefined); // not directly mapped, see below
    expect(resolveChannelName('TC_Slip')).toBe('tcSlip');
    expect(resolveChannelName('Combo_G')).toBe('gLat');
    expect(resolveChannelName('ComboAcc')).toBe('gLong');
  });

  it('resolves PDS aliases', () => {
    expect(resolveChannelName('Driver Throttle Pos')).toBe('throttle');
    expect(resolveChannelName('FBWDriverTPS')).toBe('throttle');
    expect(resolveChannelName('Brake Pressure F')).toBe('brakePressure');
    expect(resolveChannelName('X_FL_DAMPER')).toBe('damperFL');
    expect(resolveChannelName('Lap_Beacon')).toBe(undefined); // not in the alias map (internal PDS)
  });

  it('resolves GPS channels', () => {
    expect(resolveChannelName('latitude')).toBe('gpsLat');
    expect(resolveChannelName('longitude')).toBe('gpsLon');
    expect(resolveChannelName('satellites')).toBe('gpsSatellites');
    expect(resolveChannelName('solution_type')).toBe('gpsFix');
    expect(resolveChannelName('height')).toBe('gpsAlt');
    expect(resolveChannelName('velocity kmh')).toBe('gpsSpeed');
  });

  it('resolves wheel speed channels', () => {
    expect(resolveChannelName('Wheel Speed FL')).toBe('wheelSpeedFL');
    expect(resolveChannelName('wspd_fr')).toBe('wheelSpeedFR');
    expect(resolveChannelName('whlspeed_rl')).toBe('wheelSpeedRL');
    expect(resolveChannelName('V_RR_Wheel')).toBe('wheelSpeedRR');
  });

  it('is case-insensitive', () => {
    expect(resolveChannelName('ENGINE RPM')).toBe('rpm');
    expect(resolveChannelName('engine rpm')).toBe('rpm');
    expect(resolveChannelName('Engine Rpm')).toBe('rpm');
  });

  it('returns undefined for unknown channels', () => {
    expect(resolveChannelName('Warp Drive Temp')).toBeUndefined();
    expect(resolveChannelName('Custom_Sensor_42')).toBeUndefined();
  });

  it('handles special characters', () => {
    expect(resolveChannelName('P_F_BRAKE')).toBe('brakePressure');
    expect(resolveChannelName('G Force Long')).toBe('gLong');
  });
});

describe('unit normalization', () => {
  it('normalizeSpeed converts m/s to km/h', () => {
    expect(normalizeSpeed(10, 'm/s')).toBeCloseTo(36, 1);
    expect(normalizeSpeed(100, 'km/h')).toBe(100);
    expect(normalizeSpeed(60, 'mph')).toBeCloseTo(96.56, 1);
  });

  it('normalizeRatio converts % to 0-1', () => {
    expect(normalizeRatio(50, '%')).toBeCloseTo(0.5, 5);
    expect(normalizeRatio(0.8, 'ratio')).toBe(0.8);
    expect(normalizeRatio(80, '')).toBeCloseTo(0.8, 5); // >1.5 heuristic
  });

  it('normalizePressure converts psi to bar', () => {
    expect(normalizePressure(100, 'bar')).toBe(100);
    expect(normalizePressure(100, 'psi')).toBeCloseTo(6.89, 1);
    expect(normalizePressure(1000, 'kPa')).toBeCloseTo(10, 1);
  });

  it('normalizeG converts m/s² to G', () => {
    expect(normalizeG(9.81, 'm/s2')).toBeCloseTo(1.0, 2);
    expect(normalizeG(1.5, 'g')).toBe(1.5);
  });
});

describe('resolveThrottleChannels', () => {
  it('does nothing when driver throttle exists', () => {
    const map = new Map([['throttle', { rawIndex: 0, transform: null }], ['throttleActual', { rawIndex: 1, transform: null }]]);
    const result = resolveThrottleChannels(map);
    expect(result.remapped).toBe(false);
    expect(result.warning).toBeNull();
  });

  it('remaps throttleActual to throttle when driver missing', () => {
    const map = new Map([['throttleActual', { rawIndex: 0, transform: null }]]);
    const result = resolveThrottleChannels(map);
    expect(result.remapped).toBe(true);
    expect(result.warning).toContain('post-TC throttle');
    expect(map.has('throttle')).toBe(true);
    expect(map.has('throttleActual')).toBe(false);
  });
});
