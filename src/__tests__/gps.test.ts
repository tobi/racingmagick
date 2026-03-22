import { describe, it, expect } from 'vitest';
import {
  haversine, nmeaToDecimal, vboxMinutesToDecimal, radiansToDegrees,
  filterGpsForArcLength, computeGpsArcLength, integrateSpeed,
  detectCoordinateSystem, convertCoordinates,
} from '../gps';

describe('haversine', () => {
  it('computes distance between two points', () => {
    // Sebring International Raceway start/finish to Turn 1 (~400m)
    const d = haversine(27.4507, -81.3524, 27.4508, -81.3488);
    expect(d).toBeGreaterThan(300);
    expect(d).toBeLessThan(500);
  });

  it('returns 0 for same point', () => {
    expect(haversine(45.0, -75.0, 45.0, -75.0)).toBe(0);
  });

  it('handles large distances', () => {
    // New York to London (~5570 km)
    const d = haversine(40.7128, -74.006, 51.5074, -0.1278);
    expect(d).toBeGreaterThan(5_500_000);
    expect(d).toBeLessThan(5_700_000);
  });
});

describe('coordinate conversions', () => {
  it('nmeaToDecimal converts DDMM.MMMMM to DD.DDDDD', () => {
    // 2727.042 = 27° 27.042' = 27.4507°
    expect(nmeaToDecimal(2727.042)).toBeCloseTo(27.4507, 3);
    expect(nmeaToDecimal(-8121.144)).toBeCloseTo(-81.3524, 3);
    expect(nmeaToDecimal(0)).toBe(0);
  });

  it('vboxMinutesToDecimal divides by 60', () => {
    // 1647.042 minutes = 27.4507 degrees
    expect(vboxMinutesToDecimal(1647.042)).toBeCloseTo(27.4507, 3);
  });

  it('radiansToDegrees converts correctly', () => {
    expect(radiansToDegrees(Math.PI)).toBeCloseTo(180, 5);
    expect(radiansToDegrees(0)).toBe(0);
    expect(radiansToDegrees(Math.PI / 2)).toBeCloseTo(90, 5);
  });
});

describe('detectCoordinateSystem', () => {
  it('detects decimal degrees', () => {
    const lat = new Float64Array([27.4507, 27.4508]);
    const lon = new Float64Array([-81.3524, -81.3488]);
    expect(detectCoordinateSystem(lat, lon)).toBe('decimal');
  });

  it('detects NMEA format', () => {
    const lat = new Float64Array([2727.042, 2727.043]);
    const lon = new Float64Array([-8121.144, -8121.145]);
    expect(detectCoordinateSystem(lat, lon)).toBe('nmea');
  });

  it('detects radians', () => {
    const lat = new Float64Array([0.479, 0.480]);
    const lon = new Float64Array([-1.419, -1.420]);
    expect(detectCoordinateSystem(lat, lon)).toBe('radians');
  });

  it('handles all zeros as decimal', () => {
    const lat = new Float64Array([0, 0]);
    const lon = new Float64Array([0, 0]);
    expect(detectCoordinateSystem(lat, lon)).toBe('decimal');
  });
});

describe('convertCoordinates', () => {
  it('converts NMEA to decimal', () => {
    const nmea = new Float64Array([2727.042]);
    const result = convertCoordinates(nmea, 'nmea');
    expect(result[0]).toBeCloseTo(27.4507, 3);
  });

  it('passes through decimal unchanged', () => {
    const dec = new Float64Array([27.4507]);
    const result = convertCoordinates(dec, 'decimal');
    expect(result).toBe(dec); // same reference
  });
});

describe('filterGpsForArcLength', () => {
  it('marks low-satellite samples as invalid', () => {
    const n = 10;
    const lat = new Float64Array(n).fill(27.45);
    const lon = new Float64Array(n).fill(-81.35);
    const speed = new Float64Array(n).fill(100);
    const sats = new Float64Array(n).fill(12);
    sats[5] = 2; // bad satellite count

    const result = filterGpsForArcLength(lat, lon, speed, 10, sats);
    expect(result.valid[5]).toBe(false);
    expect(result.invalidCount).toBeGreaterThanOrEqual(1);
  });

  it('marks teleportation as invalid', () => {
    const lat = new Float64Array([27.45, 28.45]); // ~111 km jump
    const lon = new Float64Array([-81.35, -81.35]);
    const speed = new Float64Array([100, 100]);

    const result = filterGpsForArcLength(lat, lon, speed, 10);
    expect(result.valid[1]).toBe(false);
  });
});

describe('integrateSpeed', () => {
  it('produces cumulative distance from constant speed', () => {
    // 100 km/h for 1 second at 10 Hz = 10 samples
    const speed = new Float64Array(11).fill(100);
    const dist = integrateSpeed(speed, 10);

    // 100 km/h = 27.78 m/s. Over 1s = 27.78m
    expect(dist[0]).toBe(0);
    expect(dist[10]).toBeCloseTo(27.78, 0);
  });
});
