import { describe, it, expect } from 'vitest';
import { ChannelMatrix, buildChannelMatrix } from '../channel-matrix';
import { CH_TIME, CH_DISTANCE, CH_TRACK_POSITION, CH_SPEED, CH_THROTTLE } from '../types';

describe('ChannelMatrix', () => {
  it('stores channels at correct indices', () => {
    const nameToIndex = new Map([
      ['time', 0], ['distance', 1], ['trackPosition', 2],
      ['speed', 3], ['throttle', 4],
    ]);
    const channels = Array.from({ length: 5 }, () => new Float64Array([1, 2, 3]));
    const m = new ChannelMatrix(channels, 10, nameToIndex);

    expect(m.sampleCount).toBe(3);
    expect(m.sampleRate).toBe(10);
    expect(m.has('speed')).toBe(true);
    expect(m.has('rpm')).toBe(false);
  });

  it('row() returns Float64Array or null', () => {
    const nameToIndex = new Map([['time', 0], ['speed', 1]]);
    const channels = [new Float64Array([0, 1]), new Float64Array([100, 200])];
    const m = new ChannelMatrix(channels, 10, nameToIndex);

    expect(m.row('speed')).toEqual(new Float64Array([100, 200]));
    expect(m.row('rpm')).toBeNull();
  });

  it('throws on mismatched channel lengths', () => {
    const nameToIndex = new Map([['a', 0], ['b', 1]]);
    expect(() =>
      new ChannelMatrix(
        [new Float64Array([1, 2, 3]), new Float64Array([1, 2])],
        10,
        nameToIndex,
      ),
    ).toThrow('Channel 1 has 2 samples, expected 3');
  });

  it('computes duration from time channel', () => {
    const nameToIndex = new Map([['time', 0]]);
    const channels = [new Float64Array([0, 0.1, 0.2, 0.3])];
    const m = new ChannelMatrix(channels, 10, nameToIndex);
    expect(m.duration).toBeCloseTo(0.3, 5);
  });

  it('computes availability flags', () => {
    const nameToIndex = new Map([
      ['time', 0], ['distance', 1], ['trackPosition', 2],
      ['speed', 3], ['throttle', 4], ['rpm', 5],
      ['gpsLat', 6], ['gpsLon', 7],
    ]);
    const channels = Array.from({ length: 8 }, () => new Float64Array(10));
    const m = new ChannelMatrix(channels, 10, nameToIndex);
    const a = m.availability;

    expect(a.rpm).toBe(true);
    expect(a.gps).toBe(true);
    expect(a.gear).toBe(false);
    expect(a.wheelSpeeds).toBe(false);
  });
});

describe('buildChannelMatrix', () => {
  it('resamples channels to common frequency', () => {
    const inputs = [
      { name: 'speed', frequency: 100, samples: new Float64Array(1001) },
      { name: 'throttle', frequency: 50, samples: new Float64Array(501) },
    ];
    // Fill with ramp
    for (let i = 0; i < 1001; i++) inputs[0].samples[i] = i * 0.2;
    for (let i = 0; i < 501; i++) inputs[1].samples[i] = i * 0.001;

    const m = buildChannelMatrix(inputs, 100);
    expect(m.sampleRate).toBe(100);
    expect(m.sampleCount).toBe(1001);
    expect(m.has('speed')).toBe(true);
    expect(m.has('throttle')).toBe(true);
  });

  it('generates time channel if not provided', () => {
    const m = buildChannelMatrix([
      { name: 'speed', frequency: 10, samples: new Float64Array(11) },
      { name: 'throttle', frequency: 10, samples: new Float64Array(11) },
    ], 10);

    const time = m.row('time')!;
    expect(time[0]).toBe(0);
    expect(time[10]).toBeCloseTo(1.0, 5);
  });

  it('caps target Hz at 100 by default', () => {
    const m = buildChannelMatrix([
      { name: 'speed', frequency: 200, samples: new Float64Array(201) },
      { name: 'throttle', frequency: 200, samples: new Float64Array(201) },
    ]);
    expect(m.sampleRate).toBe(100);
  });

  it('uses nearest-neighbor for discrete channels', () => {
    const gear = new Float64Array([1, 1, 2, 2, 3, 3]);
    const m = buildChannelMatrix([
      { name: 'speed', frequency: 2, samples: new Float64Array(6).fill(100) },
      { name: 'throttle', frequency: 2, samples: new Float64Array(6).fill(0.5) },
      { name: 'gear', frequency: 2, samples: gear },
    ], 4);

    const gearOut = m.row('gear')!;
    // All values should be integers (1, 2, or 3)
    for (let i = 0; i < gearOut.length; i++) {
      expect(Number.isInteger(gearOut[i])).toBe(true);
    }
  });

  it('throws on empty input', () => {
    expect(() => buildChannelMatrix([])).toThrow('No channels provided');
  });
});
