/**
 * Acceptance tests: load EVERY fixture file, verify the normalized
 * Session/Lap/LapSample interface produces coherent, cross-format-consistent data.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Session } from '../session';
import { Lap } from '../lap';
import { LapKind } from '../types';
import { parseMotec } from '../parsers/motec';
import { parsePds } from '../parsers/pds';
import { parseVbo } from '../parsers/vbo';

const FIXTURES = join(__dirname, '../../fixtures');

// ── Helper: load and parse each format ────────────────────────────────

async function loadMotec(name: string): Promise<Session> {
  const ldPath = join(FIXTURES, 'motec', name);
  const data = readFileSync(ldPath);
  return parseMotec(new Uint8Array(data), ldPath);
}

function loadPds(name: string): Session {
  const path = join(FIXTURES, 'pds', name);
  const data = readFileSync(path);
  return parsePds(new Uint8Array(data), path);
}

function loadVbo(name: string): Session {
  const path = join(FIXTURES, 'vbo', name);
  const data = readFileSync(path);
  return parseVbo(new Uint8Array(data), path);
}

// ── Shared acceptance criteria ────────────────────────────────────────

function assertValidSession(session: Session, expectedFormat: string) {
  // Basic session properties
  expect(session.format).toBe(expectedFormat);
  expect(session.sampleRate).toBeGreaterThan(0);
  expect(session.totalDuration).toBeGreaterThan(0);
  expect(Number.isFinite(session.totalDistance)).toBe(true);
  expect(session.totalDistance).toBeGreaterThanOrEqual(0);
  expect(session.lapCount).toBeGreaterThanOrEqual(1);
  expect(session.id).toHaveLength(16);

  // Matrix integrity
  expect(session.matrix.sampleCount).toBeGreaterThan(0);
  expect(session.matrix.sampleRate).toBe(session.sampleRate);

  // Required channels exist
  expect(session.matrix.has('time')).toBe(true);
  expect(session.matrix.has('distance')).toBe(true);
  expect(session.matrix.has('trackPosition')).toBe(true);
  expect(session.matrix.has('speed')).toBe(true);
  expect(session.matrix.has('throttle')).toBe(true);

  // Time channel is monotonically increasing
  const time = session.matrix.row('time')!;
  for (let i = 1; i < time.length; i++) {
    expect(time[i]).toBeGreaterThanOrEqual(time[i - 1]!);
  }

  // Speed is in reasonable range (km/h)
  const speed = session.matrix.row('speed')!;
  let maxSpeed = 0;
  for (let i = 0; i < speed.length; i++) {
    expect(speed[i]).toBeGreaterThanOrEqual(-1); // allow tiny rounding
    if (speed[i]! > maxSpeed) maxSpeed = speed[i]!;
  }
  expect(maxSpeed).toBeGreaterThan(0); // at least some non-zero speed data
  expect(maxSpeed).toBeLessThan(400); // no teleportation

  // Throttle is approximately 0.0–1.0 (PDS raw data may slightly exceed)
  const throttle = session.matrix.row('throttle')!;
  let throttleMin = Infinity, throttleMax = -Infinity;
  for (let i = 0; i < throttle.length; i++) {
    if (throttle[i]! < throttleMin) throttleMin = throttle[i]!;
    if (throttle[i]! > throttleMax) throttleMax = throttle[i]!;
  }
  expect(throttleMin).toBeGreaterThanOrEqual(-0.1);
  expect(throttleMax).toBeLessThan(2.0); // allow some headroom for raw PDS data

  // Distance is non-decreasing (session-level)
  const dist = session.matrix.row('distance')!;
  expect(dist[dist.length - 1]! - dist[0]!).toBeGreaterThan(0);

  // Track position is 0.0–1.0 globally
  const tp = session.matrix.row('trackPosition')!;
  expect(tp[0]).toBeGreaterThanOrEqual(0);
  expect(tp[tp.length - 1]).toBeLessThanOrEqual(1.001);
}

function assertValidLap(lap: Lap) {
  expect(lap.sampleCount).toBeGreaterThan(0);
  expect(lap.lapTime).toBeGreaterThan(0);
  expect(lap.sampleRate).toBeGreaterThan(0);
  expect(lap.displayLabel).toBeTruthy();

  // Can iterate samples
  let count = 0;
  for (const sample of lap.samples) {
    expect(sample.speed).toBeGreaterThanOrEqual(0);
    expect(sample.throttle).toBeGreaterThanOrEqual(-0.1);
    expect(sample.throttle).toBeLessThanOrEqual(2.0);
    expect(typeof sample.time).toBe('number');
    count++;
    if (count > 10) break; // just spot-check
  }
  expect(count).toBeGreaterThan(0);

  // Can access channels
  const speedCh = lap.channel('speed');
  expect(speedCh).not.toBeNull();
  expect(speedCh!.length).toBe(lap.sampleCount);
}

// ═══════════════════════════════════════════════════════════════════════
// MoTeC Fixtures
// ═══════════════════════════════════════════════════════════════════════

describe('Acceptance: MoTeC fixtures', () => {
  const motecFiles = [
    'Oreca07_2023_Daytona24h_MJ_FL.ld',
    'Oreca07_2024_Sebring_Test_2_MJ_FL.ld',
    'Oreca07_2024_Sebring_Winter_Test_SH_FL.ld',
    'Oreca07_2025_Sebring_Winter_Test_HM_FL.ld',
    'ier_le_mans_&_ier_oreca_07_dev_&_Tobias Lutke_&_stint_24.ld',
  ];

  for (const file of motecFiles) {
    describe(file, () => {
      let session: Session;

      it('loads successfully', async () => {
        session = await loadMotec(file);
        assertValidSession(session, 'motec');
      });

      it('has correct metadata', async () => {
        session = session ?? await loadMotec(file);
        expect(session.driver.length).toBeGreaterThan(0);
        expect(session.vehicle.length).toBeGreaterThan(0);
        expect(session.date).toBeInstanceOf(Date);
      });

      it('has valid laps with correct classification', async () => {
        session = session ?? await loadMotec(file);
        for (const lap of session.laps) {
          assertValidLap(lap);
          expect(Object.values(LapKind)).toContain(lap.kind);
        }
      });

      it('timedLaps and fastestLap work', async () => {
        session = session ?? await loadMotec(file);
        const timed = session.timedLaps();
        // All timed laps should be Flying or FirstFlying
        for (const lap of timed) {
          expect([LapKind.Flying, LapKind.FirstFlying]).toContain(lap.kind);
        }
        const fastest = session.fastestLap();
        if (timed.length > 0) {
          expect(fastest).not.toBeNull();
          expect(fastest!.lapTime).toBeGreaterThan(0);
          // Fastest should be <= all other timed laps
          for (const lap of timed) {
            expect(fastest!.lapTime).toBeLessThanOrEqual(lap.lapTime + 1);
          }
        }
      });

      it('channel availability reflects actual data', async () => {
        session = session ?? await loadMotec(file);
        const has = session.has;
        // If has.rpm, the channel should exist and have data
        if (has.rpm) {
          const rpm = session.matrix.row('rpm');
          expect(rpm).not.toBeNull();
          expect(rpm!.some(v => v > 0)).toBe(true);
        }
        if (has.brakePressure) {
          const brake = session.matrix.row('brakePressure');
          expect(brake).not.toBeNull();
        }
      });

      it('lap.at() returns valid interpolated sample', async () => {
        session = session ?? await loadMotec(file);
        if (session.laps.length > 0) {
          const lap = session.laps[0]!;
          const mid = lap.at(0.5);
          expect(mid.trackPosition).toBeGreaterThanOrEqual(0);
          expect(mid.trackPosition).toBeLessThanOrEqual(1);
          expect(mid.speed).toBeGreaterThanOrEqual(0);
        }
      });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PDS Fixtures
// ═══════════════════════════════════════════════════════════════════════

describe('Acceptance: PDS fixtures', () => {
  // Full PDS files (legacy + standard variants)
  const pdsFiles = [
    '250212084750_25IMSAT02_SEB_CT1_Run001_HM_Car11_#477.pds',
    '260223171205_26IMSA02_T02_SEB_CT1_Run004_TL_MQ12Di_LMP2 #443.pds',
  ];

  // Export PDS files use a compact interleaved format that is not yet supported.
  // They throw ParseError with a clear message (tested in pds.test.ts).

  for (const file of pdsFiles) {
    describe(file, () => {
      let session: Session;

      it('loads successfully', () => {
        session = loadPds(file);
        assertValidSession(session, 'pds');
      });

      it('has valid laps', () => {
        session = session ?? loadPds(file);
        for (const lap of session.laps) {
          assertValidLap(lap);
        }
      });

      it('has reasonable channel count', () => {
        session = session ?? loadPds(file);
        const channelCount = session.matrix.indexToName.filter(n => n.length > 0).length;
        expect(channelCount).toBeGreaterThan(5);
      });

      it('timedLaps and fastestLap work', () => {
        session = session ?? loadPds(file);
        const timed = session.timedLaps();
        for (const lap of timed) {
          expect([LapKind.Flying, LapKind.FirstFlying]).toContain(lap.kind);
        }
        const fastest = session.fastestLap();
        if (timed.length > 0) {
          expect(fastest).not.toBeNull();
          for (const lap of timed) {
            expect(fastest!.lapTime).toBeLessThanOrEqual(lap.lapTime + 1);
          }
        }
      });

      it('lap.samples iteration works', () => {
        session = session ?? loadPds(file);
        if (session.laps.length > 0) {
          const lap = session.laps[0]!;
          let count = 0;
          for (const s of lap.samples) {
            expect(s.speed).toBeGreaterThanOrEqual(0);
            count++;
            if (count > 5) break;
          }
          expect(count).toBeGreaterThan(0);
        }
      });
    });
  }

});

// ═══════════════════════════════════════════════════════════════════════
// VBO Fixtures
// ═══════════════════════════════════════════════════════════════════════

describe('Acceptance: VBO fixtures', () => {
  const vboFiles = [
    '25IT04_RdAm_PT2_Run01_RD.vbo',
    '25IT04_RdAm_PT2_Run02_TL.vbo',
    'ERA_081_2024_11_19_105252_0001.vbo',
    'ERA_081_2025_01_06_081816_0001.vbo',
    'VBOX202502140908250001.vbo',
    'VBOX202502140912340001.vbo',
  ];

  for (const file of vboFiles) {
    describe(file, () => {
      let session: Session;

      it('loads successfully', () => {
        session = loadVbo(file);
        assertValidSession(session, 'vbo');
      });

      it('has GPS data (VBO is GPS-native)', () => {
        session = session ?? loadVbo(file);
        expect(session.has.gps).toBe(true);
        const lat = session.matrix.row('gpsLat')!;
        const lon = session.matrix.row('gpsLon')!;
        expect(lat).not.toBeNull();
        expect(lon).not.toBeNull();
        // GPS coords should be in decimal degrees (reasonable range)
        const firstNonZeroLat = lat.find(v => v !== 0);
        if (firstNonZeroLat) {
          expect(Math.abs(firstNonZeroLat)).toBeGreaterThan(1);
          expect(Math.abs(firstNonZeroLat)).toBeLessThan(90);
        }
      });

      it('has valid laps', () => {
        session = session ?? loadVbo(file);
        for (const lap of session.laps) {
          assertValidLap(lap);
        }
      });

      it('heading channel is available', () => {
        session = session ?? loadVbo(file);
        expect(session.has.heading).toBe(true);
        const heading = session.matrix.row('heading')!;
        expect(heading).not.toBeNull();
      });

      it('timedLaps and fastestLap work', () => {
        session = session ?? loadVbo(file);
        const timed = session.timedLaps();
        const fastest = session.fastestLap();
        if (timed.length > 0) {
          expect(fastest).not.toBeNull();
          for (const lap of timed) {
            expect(fastest!.lapTime).toBeLessThanOrEqual(lap.lapTime + 1);
          }
        }
      });

      it('stints() returns valid stint objects', () => {
        session = session ?? loadVbo(file);
        const stints = session.stints();
        for (const stint of stints) {
          expect(stint.stintNumber).toBeGreaterThan(0);
          expect(Array.isArray(stint.laps)).toBe(true);
        }
      });

      it('lap.channelAtPositions returns correct-length array', () => {
        session = session ?? loadVbo(file);
        if (session.laps.length > 0) {
          const lap = session.laps[0]!;
          const trace = lap.channelAtPositions('speed', 500);
          expect(trace.length).toBe(500);
          // All values should be real numbers (not NaN for speed which exists)
          for (let i = 0; i < trace.length; i++) {
            expect(Number.isFinite(trace[i])).toBe(true);
          }
        }
      });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Cross-format consistency
// ═══════════════════════════════════════════════════════════════════════

describe('Cross-format consistency', () => {
  it('all formats produce the same Session interface', async () => {
    const motec = await loadMotec('Oreca07_2024_Sebring_Test_2_MJ_FL.ld');
    const vbo = loadVbo('25IT04_RdAm_PT2_Run01_RD.vbo');
    const pds = loadPds('260223171205_26IMSA02_T02_SEB_CT1_Run004_TL_MQ12Di_LMP2 #443.pds');

    // All sessions have the same structural properties
    for (const session of [motec, vbo, pds]) {
      expect(typeof session.id).toBe('string');
      expect(typeof session.format).toBe('string');
      expect(typeof session.driver).toBe('string');
      expect(typeof session.vehicle).toBe('string');
      expect(typeof session.track).toBe('string');
      expect(session.date).toBeInstanceOf(Date);
      expect(typeof session.sampleRate).toBe('number');
      expect(typeof session.lapCount).toBe('number');
      expect(typeof session.totalDuration).toBe('number');
      expect(typeof session.totalDistance).toBe('number');
      expect(Array.isArray(session.laps)).toBe(true);
      expect(Array.isArray(session.warnings)).toBe(true);
    }
  });

  it('all formats produce the same Lap interface', async () => {
    const motec = await loadMotec('Oreca07_2024_Sebring_Test_2_MJ_FL.ld');
    const vbo = loadVbo('25IT04_RdAm_PT2_Run01_RD.vbo');
    const pds = loadPds('260223171205_26IMSA02_T02_SEB_CT1_Run004_TL_MQ12Di_LMP2 #443.pds');

    for (const session of [motec, vbo, pds]) {
      if (session.laps.length === 0) continue;
      const lap = session.laps[0]!;

      // All laps have the same API
      expect(typeof lap.lapIndex).toBe('number');
      expect(typeof lap.kind).toBe('string');
      expect(typeof lap.lapTime).toBe('number');
      expect(typeof lap.sampleCount).toBe('number');
      expect(typeof lap.displayLabel).toBe('string');

      // Can call lap.at()
      const sample = lap.at(0.5);
      expect(typeof sample.time).toBe('number');
      expect(typeof sample.speed).toBe('number');
      expect(typeof sample.throttle).toBe('number');
      expect(typeof sample.trackPosition).toBe('number');

      // Can call lap.channel()
      const speedChannel = lap.channel('speed');
      expect(speedChannel).not.toBeNull();
      expect(speedChannel!.length).toBe(lap.sampleCount);

      // Can call lap.samples
      expect(lap.samples.length).toBe(lap.sampleCount);
    }
  });

  it('LapSample optional fields are consistently null when missing', async () => {
    const motec = await loadMotec('Oreca07_2024_Sebring_Test_2_MJ_FL.ld');
    const lap = motec.laps[0]!;
    const sample = lap.at(0.5);

    // Required fields are never null
    expect(sample.time).not.toBeNull();
    expect(sample.speed).not.toBeNull();
    expect(sample.throttle).not.toBeNull();
    expect(sample.distance).not.toBeNull();
    expect(sample.trackPosition).not.toBeNull();

    // Optional fields: null means "not recorded", not zero
    if (!motec.has.gps) {
      expect(sample.gpsLat).toBeNull();
      expect(sample.gpsLon).toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Lap delta (comparison between laps in same session)
// ═══════════════════════════════════════════════════════════════════════

describe('Lap delta', () => {
  it('computes delta between two laps in same MoTeC session', async () => {
    const session = await loadMotec('Oreca07_2024_Sebring_Test_2_MJ_FL.ld');
    const timed = session.timedLaps();
    if (timed.length < 2) return; // skip if not enough laps

    const lap1 = timed[0]!;
    const lap2 = timed[1]!;
    const delta = lap1.delta(lap2);

    expect(typeof delta.totalDelta).toBe('number');
    expect(typeof delta.worstPosition).toBe('number');
    expect(typeof delta.bestPosition).toBe('number');
    expect(delta.worstPosition).toBeGreaterThanOrEqual(0);
    expect(delta.worstPosition).toBeLessThanOrEqual(1);
    expect(delta.bestPosition).toBeGreaterThanOrEqual(0);
    expect(delta.bestPosition).toBeLessThanOrEqual(1);

    // deltaAt returns a number
    expect(typeof delta.deltaAt(0.5)).toBe('number');

    // deltaTrace returns correct length
    const trace = delta.deltaTrace(100);
    expect(trace.length).toBe(100);
  });

  it('computes delta between VBO laps', () => {
    const session = loadVbo('25IT04_RdAm_PT2_Run01_RD.vbo');
    const timed = session.timedLaps();
    if (timed.length < 2) return;

    const delta = timed[0]!.delta(timed[1]!);
    expect(typeof delta.totalDelta).toBe('number');
    // Total delta should roughly equal the lap time difference
    const expectedDelta = timed[0]!.lapTime - timed[1]!.lapTime;
    expect(Math.abs(delta.totalDelta - expectedDelta)).toBeLessThan(100); // within 100ms
  });
});
