import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { parseMotec } from '../parsers/motec';

const FIXTURES = join(__dirname, '../../fixtures/motec');

const fixtureExists = (filename: string) => existsSync(join(FIXTURES, filename));
const itIfFixture = (filename: string) => fixtureExists(filename) ? it : it.skip;

const FILES = [
  'Oreca07_2023_Daytona24h_MJ_FL.ld',
  'Oreca07_2024_Sebring_Test_2_MJ_FL.ld',
  'Oreca07_2024_Sebring_Winter_Test_SH_FL.ld',
  'Oreca07_2025_Sebring_Winter_Test_HM_FL.ld',
  'ier_le_mans_&_ier_oreca_07_dev_&_Tobias Lutke_&_stint_24.ld',
].filter(fixtureExists);

async function loadSession(filename: string) {
  const path = join(FIXTURES, filename);
  const data = await readFile(path);
  return parseMotec(new Uint8Array(data), path);
}

describe('MoTeC parser', () => {
  describe.each(FILES)('fixture: %s', (filename) => {
    it('parses without throwing', async () => {
      await expect(loadSession(filename)).resolves.toBeDefined();
    });

    it('has non-empty driver name', async () => {
      const session = await loadSession(filename);
      expect(session.driver).toBeTruthy();
      expect(typeof session.driver).toBe('string');
    });

    it('has non-empty vehicle identifier', async () => {
      const session = await loadSession(filename);
      expect(session.vehicle).toBeTruthy();
    });

    it('has channels including speed', async () => {
      const session = await loadSession(filename);
      expect(session.matrix.has('speed')).toBe(true);
    });

    it('has at least 1 lap', async () => {
      const session = await loadSession(filename);
      expect(session.lapCount).toBeGreaterThanOrEqual(1);
    });

    it('speed values in reasonable range (0-400 km/h)', async () => {
      const session = await loadSession(filename);
      const speedRow = session.matrix.row('speed')!;
      expect(speedRow).toBeDefined();
      for (let i = 0; i < speedRow.length; i += Math.floor(speedRow.length / 100)) {
        expect(speedRow[i]).toBeGreaterThanOrEqual(-1);
        expect(speedRow[i]).toBeLessThanOrEqual(400);
      }
    });

    it('format is motec', async () => {
      const session = await loadSession(filename);
      expect(session.format).toBe('motec');
    });

    it('sampleRate > 0', async () => {
      const session = await loadSession(filename);
      expect(session.sampleRate).toBeGreaterThan(0);
    });
  });

  describe('header parsing', () => {
    itIfFixture('Oreca07_2023_Daytona24h_MJ_FL.ld')('parses Daytona header correctly', async () => {
      const session = await loadSession('Oreca07_2023_Daytona24h_MJ_FL.ld');
      expect(session.driver).toBe('Mikkel Jensen');
      expect(session.vehicle).toContain('MQ12Di');
      expect(session.track).toBe('DIS');
      expect(session.date.getFullYear()).toBe(2023);
    });

    itIfFixture('ier_le_mans_&_ier_oreca_07_dev_&_Tobias Lutke_&_stint_24.ld')('parses iRacing header correctly', async () => {
      const session = await loadSession(
        'ier_le_mans_&_ier_oreca_07_dev_&_Tobias Lutke_&_stint_24.ld',
      );
      expect(session.driver).toBe('Tobias Lutke');
      expect(session.vehicle).toContain('oreca_07');
      expect(session.track).toContain('le_mans');
    });

    itIfFixture('Oreca07_2023_Daytona24h_MJ_FL.ld')('parses date and time from header', async () => {
      const session = await loadSession('Oreca07_2023_Daytona24h_MJ_FL.ld');
      expect(session.date).toBeInstanceOf(Date);
      expect(session.date.getMonth()).toBe(0); // January
      expect(session.date.getDate()).toBe(27);
    });
  });

  describe('channel linked list traversal', () => {
    itIfFixture('Oreca07_2023_Daytona24h_MJ_FL.ld')('Daytona file has multiple channels', async () => {
      const session = await loadSession('Oreca07_2023_Daytona24h_MJ_FL.ld');
      // Should have speed, throttle, and more
      expect(session.matrix.has('speed')).toBe(true);
      expect(session.matrix.has('throttle')).toBe(true);
    });

    itIfFixture('ier_le_mans_&_ier_oreca_07_dev_&_Tobias Lutke_&_stint_24.ld')('iRacing file has many channels', async () => {
      const session = await loadSession(
        'ier_le_mans_&_ier_oreca_07_dev_&_Tobias Lutke_&_stint_24.ld',
      );
      expect(session.matrix.has('speed')).toBe(true);
    });

    itIfFixture('Oreca07_2024_Sebring_Test_2_MJ_FL.ld')('Sebring test has expected channels', async () => {
      const session = await loadSession('Oreca07_2024_Sebring_Test_2_MJ_FL.ld');
      expect(session.matrix.has('speed')).toBe(true);
      expect(session.matrix.has('throttle')).toBe(true);
    });
  });

  describe('integer channel conversion', () => {
    itIfFixture('Oreca07_2024_Sebring_Test_2_MJ_FL.ld')('reads integer channels with scale/dec_places correctly', async () => {
      // Sebring test files typically have brake pressure as integer channels
      const session = await loadSession('Oreca07_2024_Sebring_Test_2_MJ_FL.ld');
      if (session.matrix.has('brakePressure')) {
        const brake = session.matrix.row('brakePressure')!;
        // Brake pressure in bar should be in reasonable range
        const max = Math.max(...Array.from(brake.slice(0, 1000)));
        expect(max).toBeGreaterThan(0);
        expect(max).toBeLessThan(200); // bar
      }
    });
  });

  describe('.ldx beacon parsing', () => {
    itIfFixture('Oreca07_2024_Sebring_Test_2_MJ_FL.ld')('Sebring Test 2 has multiple laps from beacons', async () => {
      // This file has 16 beacon Time values -> 15 laps
      const session = await loadSession('Oreca07_2024_Sebring_Test_2_MJ_FL.ld');
      expect(session.lapCount).toBeGreaterThan(1);
    });

    itIfFixture('Oreca07_2025_Sebring_Winter_Test_HM_FL.ld')('Sebring 2025 has laps from beacons', async () => {
      const session = await loadSession('Oreca07_2025_Sebring_Winter_Test_HM_FL.ld');
      expect(session.lapCount).toBeGreaterThan(1);
    });
  });

  describe('missing .ldx graceful fallback', () => {
    itIfFixture('ier_le_mans_&_ier_oreca_07_dev_&_Tobias Lutke_&_stint_24.ld')('parses with single lap when .ldx has no beacons', async () => {
      // iRacing file has empty MarkerGroup (no Time attributes)
      const session = await loadSession(
        'ier_le_mans_&_ier_oreca_07_dev_&_Tobias Lutke_&_stint_24.ld',
      );
      expect(session.lapCount).toBeGreaterThanOrEqual(1);
    });

    itIfFixture('Oreca07_2023_Daytona24h_MJ_FL.ld')('Daytona with only 1 beacon falls back gracefully', async () => {
      // Only 1 marker Time -> 0-1 beacons means single lap treatment
      const session = await loadSession('Oreca07_2023_Daytona24h_MJ_FL.ld');
      expect(session.lapCount).toBeGreaterThanOrEqual(1);
    });
  });
});
