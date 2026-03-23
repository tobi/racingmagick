import { describe, it, expect } from 'vitest';
import { ChannelMatrix } from '../channel-matrix';
import { classifyLap, buildLaps } from '../lap-classification';
import { LapKind, CH_TIME, CH_DISTANCE, CH_SPEED } from '../types';

function makeSimpleMatrix(speedProfile: number[], hz: number = 10): ChannelMatrix {
  const n = speedProfile.length;
  const nameToIndex = new Map([
    ['time', 0], ['distance', 1], ['trackPosition', 2],
    ['speed', 3], ['throttle', 4],
  ]);
  const channels: Float64Array[] = [];
  for (let i = 0; i < 5; i++) channels.push(new Float64Array(n));

  for (let i = 0; i < n; i++) {
    channels[0][i] = i / hz; // time
    channels[1][i] = i * 5;  // distance (arbitrary)
    channels[2][i] = i / (n - 1); // trackPosition
    channels[3][i] = speedProfile[i]; // speed
    channels[4][i] = 0.5; // throttle
  }

  return new ChannelMatrix(channels, hz, nameToIndex);
}

describe('classifyLap', () => {
  it('classifies a flying lap (constant high speed, >30s)', () => {
    const speed = new Array(400).fill(200); // 40s at 10Hz
    const m = makeSimpleMatrix(speed);
    const kind = classifyLap({ startIdx: 0, endIdx: 400 }, m, null);
    expect(kind).toBe(LapKind.Flying);
  });

  it('classifies an out-lap (starts slow, ends fast)', () => {
    const speed: number[] = [];
    for (let i = 0; i < 100; i++) {
      speed.push(i < 30 ? 40 : 200); // pit speed → racing speed
    }
    const m = makeSimpleMatrix(speed);
    const kind = classifyLap({ startIdx: 0, endIdx: 100 }, m, null);
    expect(kind).toBe(LapKind.OutLap);
  });

  it('classifies an in-lap (starts fast, ends slow)', () => {
    const speed: number[] = [];
    for (let i = 0; i < 100; i++) {
      speed.push(i < 70 ? 200 : 40); // racing speed → pit speed
    }
    const m = makeSimpleMatrix(speed);
    const kind = classifyLap({ startIdx: 0, endIdx: 100 }, m, null);
    expect(kind).toBe(LapKind.InLap);
  });

  it('classifies first-flying after out-lap', () => {
    const speed = new Array(400).fill(200); // 40s at 10Hz
    const m = makeSimpleMatrix(speed);
    const kind = classifyLap(
      { startIdx: 0, endIdx: 400 },
      m,
      { kind: LapKind.OutLap },
    );
    expect(kind).toBe(LapKind.FirstFlying);
  });

  it('classifies a slow lap (min speed < 10, long duration)', () => {
    // Both start and end are above pit threshold but has a near-stop in the middle
    const speed: number[] = [];
    for (let i = 0; i < 500; i++) {
      if (i < 50) speed.push(80);
      else if (i < 300) speed.push(5); // near-stationary for a long stretch
      else speed.push(80);
    }
    const m = makeSimpleMatrix(speed);
    const kind = classifyLap({ startIdx: 0, endIdx: 500 }, m, null);
    expect(kind).toBe(LapKind.Slow);
  });
});

describe('buildLaps', () => {
  it('creates single lap when < 2 boundaries', () => {
    const speed = new Array(100).fill(200);
    const m = makeSimpleMatrix(speed);
    const laps = buildLaps(m, [], 'distance');
    expect(laps.length).toBe(1);
    expect(laps[0].kind).toBe(LapKind.Flying);
    expect(laps[0].lapNumber).toBe(1);
    expect(laps[0].displayLabel).toBe('L1');
  });

  it('splits correctly on boundaries', () => {
    const speed = new Array(1200).fill(200); // 120s at 10Hz
    const m = makeSimpleMatrix(speed);
    const boundaries = [
      { timeSeconds: 0 },
      { timeSeconds: 50 },
      { timeSeconds: 100 },
    ];
    const laps = buildLaps(m, boundaries, 'distance');
    expect(laps.length).toBe(2);
    expect(laps[0].lapNumber).toBe(1);
    expect(laps[1].lapNumber).toBe(2);
  });

  it('numbers only flying laps', () => {
    // Create speed profile: out-lap → flying → flying → in-lap
    // Each lap 40s (400 samples at 10Hz) to pass the >30s threshold
    const hz = 10;
    const speed: number[] = [];
    // Out-lap: 40s, starts at 40, ends at 200
    for (let i = 0; i < 400; i++) speed.push(i < 120 ? 40 : 200);
    // Flying: 40s at 200
    for (let i = 0; i < 400; i++) speed.push(200);
    // Flying: 40s at 200
    for (let i = 0; i < 400; i++) speed.push(200);
    // In-lap: 40s, starts at 200, ends at 40
    for (let i = 0; i < 400; i++) speed.push(i < 280 ? 200 : 40);

    const m = makeSimpleMatrix(speed, hz);
    const boundaries = [
      { timeSeconds: 0 },
      { timeSeconds: 40 },
      { timeSeconds: 80 },
      { timeSeconds: 120 },
      { timeSeconds: 160 },
    ];
    const laps = buildLaps(m, boundaries, 'distance');

    expect(laps.length).toBe(4);
    expect(laps[0].kind).toBe(LapKind.OutLap);
    expect(laps[0].lapNumber).toBeNull();
    expect(laps[0].displayLabel).toBe('OUT');

    expect(laps[1].kind).toBe(LapKind.FirstFlying);
    expect(laps[1].lapNumber).toBe(1);

    expect(laps[2].kind).toBe(LapKind.Flying);
    expect(laps[2].lapNumber).toBe(2);

    expect(laps[3].kind).toBe(LapKind.InLap);
    expect(laps[3].lapNumber).toBeNull();
    expect(laps[3].displayLabel).toBe('IN');
  });
});
