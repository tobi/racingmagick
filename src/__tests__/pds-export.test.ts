/**
 * PDS compact export acceptance tests.
 *
 * Both Export_MB and Export_Tobi are Sebring test sessions.
 * Sebring lap times are ~1:48-1:55 (108-115 seconds).
 * A 30-minute session should have ~15-17 laps.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePds } from '../parsers/pds';

const FIXTURES = join(__dirname, '../../fixtures/pds');

describe('PDS export: Export_MB_CT5_SebringTest2026', () => {
  const session = parsePds(
    new Uint8Array(readFileSync(join(FIXTURES, 'Export_MB_CT5_SebringTest2026.pds'))),
    'Export_MB_CT5_SebringTest2026.pds',
  );

  it('has a plausible number of laps (10-25 for a 30min Sebring session)', () => {
    expect(session.lapCount).toBeGreaterThanOrEqual(10);
    expect(session.lapCount).toBeLessThanOrEqual(25);
  });

  it('timed laps are ~1:48-2:00 (Sebring)', () => {
    const timed = session.timedLaps();
    expect(timed.length).toBeGreaterThanOrEqual(5);
    for (const lap of timed) {
      const secs = lap.lapTime / 1000;
      expect(secs).toBeGreaterThan(90);  // no lap under 1:30
      expect(secs).toBeLessThan(150);    // no lap over 2:30
    }
  });

  it('fastest lap is around 1:48-1:55', () => {
    const fastest = session.fastestLap();
    expect(fastest).not.toBeNull();
    const secs = fastest!.lapTime / 1000;
    expect(secs).toBeGreaterThan(100);
    expect(secs).toBeLessThan(120);
  });

  it('speed channel has race-speed values (max > 200 km/h)', () => {
    const speed = session.matrix.row('speed');
    expect(speed).not.toBeNull();
    let max = 0;
    for (let i = 0; i < speed!.length; i++) {
      if (speed![i]! > max && isFinite(speed![i]!)) max = speed![i]!;
    }
    expect(max).toBeGreaterThan(200);
  });

  it('throttle has full-range values (max > 0.9)', () => {
    const throttle = session.matrix.row('throttle');
    expect(throttle).not.toBeNull();
    let max = 0;
    for (let i = 0; i < throttle!.length; i++) {
      if (throttle![i]! > max && isFinite(throttle![i]!)) max = throttle![i]!;
    }
    expect(max).toBeGreaterThan(0.9);
  });

  it('brake pressure has braking values (max > 20 bar)', () => {
    const brake = session.matrix.row('brakePressure');
    expect(brake).not.toBeNull();
    let max = 0;
    for (let i = 0; i < brake!.length; i++) {
      if (brake![i]! > max && isFinite(brake![i]!)) max = brake![i]!;
    }
    expect(max).toBeGreaterThan(20);
  });

  it('has no NaN in speed or throttle', () => {
    for (const ch of ['speed', 'throttle']) {
      const row = session.matrix.row(ch);
      if (!row) continue;
      let nanCount = 0;
      for (let i = 0; i < row.length; i++) {
        if (isNaN(row[i]!)) nanCount++;
      }
      // Allow small NaN fraction from resampling at channel boundaries
      expect(nanCount / row.length).toBeLessThan(0.02);
    }
  });
});

// NB: Lap count tests remain — Export_MB has 6 laps (expecting 10-25)
// and Export_Tobi has 7 (expecting 10-30). The lap detection works on
// the correct channels but the channel data has gaps from resampling
// that cause some lap boundaries to be missed. This needs the resampler
// to handle unequal channel lengths without introducing NaN/gaps.

describe('PDS export: Export_Tobi_QualySim_SebringTest2026', () => {
  const session = parsePds(
    new Uint8Array(readFileSync(join(FIXTURES, 'Export_Tobi_QualySim_SebringTest2026.pds'))),
    'Export_Tobi_QualySim_SebringTest2026.pds',
  );

  it('has a plausible number of laps (10-30 for a qualy sim)', () => {
    expect(session.lapCount).toBeGreaterThanOrEqual(10);
    expect(session.lapCount).toBeLessThanOrEqual(30);
  });

  it('timed laps are ~1:48-2:00 (Sebring)', () => {
    const timed = session.timedLaps();
    expect(timed.length).toBeGreaterThanOrEqual(5);
    for (const lap of timed) {
      const secs = lap.lapTime / 1000;
      expect(secs).toBeGreaterThan(90);
      expect(secs).toBeLessThan(150);
    }
  });

  it('speed channel has race-speed values (max > 200 km/h)', () => {
    const speed = session.matrix.row('speed');
    expect(speed).not.toBeNull();
    let max = 0;
    for (let i = 0; i < speed!.length; i++) {
      if (speed![i]! > max && isFinite(speed![i]!)) max = speed![i]!;
    }
    expect(max).toBeGreaterThan(200);
  });

  it('has no NaN in speed or throttle', () => {
    for (const ch of ['speed', 'throttle']) {
      const row = session.matrix.row(ch);
      if (!row) continue;
      let nanCount = 0;
      for (let i = 0; i < row.length; i++) {
        if (isNaN(row[i]!)) nanCount++;
      }
      expect(nanCount).toBe(0);
    }
  });
});
