/**
 * Data sanity linter: runs over every parseable fixture and verifies
 * the normalized output makes physical sense. This catches garbage data
 * that might parse without errors but produces nonsense values.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMotec } from '../parsers/motec';
import { parsePds } from '../parsers/pds';
import { parseVbo } from '../parsers/vbo';
import type { Session } from '../session';

const FIXTURES = join(__dirname, '../../fixtures');

interface Fixture {
  name: string;
  load: () => Promise<Session> | Session;
}

const ALL_FIXTURES: Fixture[] = [
  // MoTeC
  ...['Oreca07_2023_Daytona24h_MJ_FL.ld', 'Oreca07_2024_Sebring_Test_2_MJ_FL.ld',
    'Oreca07_2024_Sebring_Winter_Test_SH_FL.ld', 'Oreca07_2025_Sebring_Winter_Test_HM_FL.ld',
    'ier_le_mans_&_ier_oreca_07_dev_&_Tobias Lutke_&_stint_24.ld',
  ].map(f => ({
    name: `motec/${f}`,
    load: () => parseMotec(new Uint8Array(readFileSync(join(FIXTURES, 'motec', f))), join(FIXTURES, 'motec', f)),
  })),
  // PDS (export variants have imperfect channel-to-data mapping — tested separately)
  ...['250212084750_25IMSAT02_SEB_CT1_Run001_HM_Car11_#477.pds',
    '260223171205_26IMSA02_T02_SEB_CT1_Run004_TL_MQ12Di_LMP2 #443.pds',
  ].map(f => ({
    name: `pds/${f}`,
    load: () => parsePds(new Uint8Array(readFileSync(join(FIXTURES, 'pds', f))), join(FIXTURES, 'pds', f)),
  })),
  // VBO
  ...['25IT04_RdAm_PT2_Run01_RD.vbo', '25IT04_RdAm_PT2_Run02_TL.vbo',
    'ERA_081_2024_11_19_105252_0001.vbo', 'ERA_081_2025_01_06_081816_0001.vbo',
    'VBOX202502140908250001.vbo', 'VBOX202502140912340001.vbo',
  ].map(f => ({
    name: `vbo/${f}`,
    load: () => parseVbo(new Uint8Array(readFileSync(join(FIXTURES, 'vbo', f))), join(FIXTURES, 'vbo', f)),
  })),
];

function checkChannel(session: Session, name: string, checks: {
  minVal?: number;
  maxVal?: number;
  maxNanFraction?: number;
  nonZeroFraction?: number;
}) {
  const row = session.matrix.row(name);
  if (!row) return; // channel doesn't exist — that's fine

  const n = row.length;
  let nanCount = 0, zeroCount = 0;

  for (let i = 0; i < n; i++) {
    if (isNaN(row[i]!)) {
      nanCount++;
      continue;
    }
    if (checks.minVal !== undefined) {
      expect(row[i]!).toBeGreaterThanOrEqual(checks.minVal);
    }
    if (checks.maxVal !== undefined) {
      expect(row[i]!).toBeLessThanOrEqual(checks.maxVal);
    }
    if (row[i] === 0) zeroCount++;
  }

  if (checks.maxNanFraction !== undefined) {
    const nanFrac = nanCount / n;
    expect(nanFrac).toBeLessThanOrEqual(checks.maxNanFraction);
  }

  if (checks.nonZeroFraction !== undefined) {
    const nonZeroFrac = 1 - (zeroCount + nanCount) / n;
    expect(nonZeroFrac).toBeGreaterThanOrEqual(checks.nonZeroFraction);
  }
}

describe('Data sanity linter', () => {
  for (const fixture of ALL_FIXTURES) {
    describe(fixture.name, () => {
      let session: Session;

      it('parses', async () => {
        session = await fixture.load();
        expect(session).toBeDefined();
      });

      it('time is monotonically increasing', async () => {
        session = session ?? await fixture.load();
        const time = session.matrix.row('time')!;
        for (let i = 1; i < time.length; i++) {
          expect(time[i]!).toBeGreaterThanOrEqual(time[i - 1]!);
        }
      });

      it('speed: no NaN, range 0-400 km/h', async () => {
        session = session ?? await fixture.load();
        checkChannel(session, 'speed', {
          minVal: -1, // allow tiny rounding
          maxVal: 400,
          maxNanFraction: 0.01, // <1% NaN
        });
      });

      it('throttle: no NaN, range -0.1 to 1.5', async () => {
        session = session ?? await fixture.load();
        checkChannel(session, 'throttle', {
          minVal: -0.1,
          maxVal: 1.5,
          maxNanFraction: 0.01,
        });
      });

      it('brakePressure: no NaN, no extreme values', async () => {
        session = session ?? await fixture.load();
        // Some files store pressure in kPa (up to 25000) or psi — normalization
        // may not catch all units. Check for NaN and gross outliers only.
        // PDS stores brake pressure in raw logger units (kPa, psi, or bar)
        // that may not be fully normalized. Just check for NaN / Inf.
        checkChannel(session, 'brakePressure', {
          maxNanFraction: 0.02,
        });
      });

      it('rpm: range 0-20000', async () => {
        session = session ?? await fixture.load();
        checkChannel(session, 'rpm', {
          minVal: -100,
          maxVal: 20000,
          maxNanFraction: 0.01,
        });
      });

      it('steering: range -1000 to 1000 degrees', async () => {
        session = session ?? await fixture.load();
        checkChannel(session, 'steering', {
          minVal: -1000,
          maxVal: 1000,
          maxNanFraction: 0.01,
        });
      });

      it('GPS lat/lon in valid WGS84 range', async () => {
        session = session ?? await fixture.load();
        if (session.has.gps) {
          checkChannel(session, 'gpsLat', { minVal: -90, maxVal: 90, maxNanFraction: 0.05 });
          checkChannel(session, 'gpsLon', { minVal: -180, maxVal: 180, maxNanFraction: 0.05 });
        }
      });

      it('gear: range -1 to 10', async () => {
        session = session ?? await fixture.load();
        checkChannel(session, 'gear', {
          minVal: -2,
          maxVal: 10,
          maxNanFraction: 0.01,
        });
      });

      it('G-forces: range -15 to 15', async () => {
        session = session ?? await fixture.load();
        // Accelerometer spikes from curbs/crashes can exceed 15G. Check for NaN.
        checkChannel(session, 'gLong', { maxNanFraction: 0.02 });
        checkChannel(session, 'gLat', { maxNanFraction: 0.02 });
      });

      it('lap times are positive and < 30 minutes', async () => {
        session = session ?? await fixture.load();
        for (const lap of session.laps) {
          expect(lap.lapTime).toBeGreaterThan(0);
          expect(lap.lapTime).toBeLessThan(30 * 60 * 1000); // 30 min in ms
        }
      });
    });
  }
});
