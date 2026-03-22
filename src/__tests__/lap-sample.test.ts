import { describe, it, expect } from 'vitest';
import { ChannelMatrix } from '../channel-matrix';
import { LapSample, LapSampleSlice } from '../lap-sample';

function makeMatrix() {
  const n = 100;
  const nameToIndex = new Map([
    ['time', 0], ['distance', 1], ['trackPosition', 2],
    ['speed', 3], ['throttle', 4], ['rpm', 5],
    ['throttleActual', 6], ['gear', 7],
  ]);
  const channels: Float64Array[] = [];
  for (let i = 0; i < 8; i++) channels.push(new Float64Array(n));

  // Fill with meaningful data
  for (let i = 0; i < n; i++) {
    channels[0][i] = i * 0.01; // time: 0-0.99s
    channels[1][i] = i * 2;    // distance: 0-198m
    channels[2][i] = i / (n - 1); // trackPosition: 0-1
    channels[3][i] = 100 + i;  // speed: 100-199 km/h
    channels[4][i] = 0.8;      // throttle: 80%
    channels[5][i] = 7000 + i * 10; // rpm: 7000-7990
    channels[6][i] = 0.7;      // throttleActual
    channels[7][i] = 4;        // gear
  }

  return new ChannelMatrix(channels, 100, nameToIndex);
}

describe('LapSample', () => {
  it('reads required channels directly', () => {
    const m = makeMatrix();
    const s = new LapSample(m, 50);

    expect(s.time).toBeCloseTo(0.5, 5);
    expect(s.distance).toBe(100);
    expect(s.trackPosition).toBeCloseTo(50 / 99, 5);
    expect(s.speed).toBe(150);
    expect(s.throttle).toBe(0.8);
  });

  it('reads optional channels, returns null if missing', () => {
    const m = makeMatrix();
    const s = new LapSample(m, 0);

    expect(s.rpm).toBe(7000);
    expect(s.gear).toBe(4);
    expect(s.gpsLat).toBeNull();
    expect(s.damperFL).toBeNull();
  });

  it('computes tcActive from throttle difference', () => {
    const m = makeMatrix();
    const s = new LapSample(m, 0);
    // throttle=0.8, throttleActual=0.7 → diff=0.1 > 0.02
    expect(s.tcActive).toBe(true);
  });

  it('tcActive is false when throttleActual is null', () => {
    const nameToIndex = new Map([
      ['time', 0], ['distance', 1], ['trackPosition', 2],
      ['speed', 3], ['throttle', 4],
    ]);
    const channels = Array.from({ length: 5 }, () => new Float64Array(10).fill(1));
    const m = new ChannelMatrix(channels, 10, nameToIndex);
    const s = new LapSample(m, 0);
    expect(s.tcActive).toBe(false);
  });
});

describe('LapSampleSlice', () => {
  it('iterates over samples', () => {
    const m = makeMatrix();
    const slice = new LapSampleSlice(m, 10, 20);

    expect(slice.length).toBe(10);

    const samples = [...slice];
    expect(samples.length).toBe(10);
    expect(samples[0].speed).toBe(110);
    expect(samples[9].speed).toBe(119);
  });

  it('at() returns correct sample', () => {
    const m = makeMatrix();
    const slice = new LapSampleSlice(m, 10, 20);

    expect(slice.at(0).speed).toBe(110);
    expect(slice.at(5).speed).toBe(115);
  });

  it('at() throws on out of range', () => {
    const m = makeMatrix();
    const slice = new LapSampleSlice(m, 10, 20);

    expect(() => slice.at(10)).toThrow('out of range');
    expect(() => slice.at(-1)).toThrow('out of range');
  });

  it('channel() returns subarray view', () => {
    const m = makeMatrix();
    const slice = new LapSampleSlice(m, 10, 20);

    const speedSlice = slice.channel('speed')!;
    expect(speedSlice.length).toBe(10);
    expect(speedSlice[0]).toBe(110);

    // Verify zero-copy (modifying source affects slice)
    expect(slice.channel('nonexistent')).toBeNull();
  });
});
