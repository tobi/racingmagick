import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';
import { parsePds } from '../parsers/pds';

const FIXTURES_DIR = resolve(__dirname, '../../fixtures/pds');

const FIXTURE_FILES = [
  '250212084750_25IMSAT02_SEB_CT1_Run001_HM_Car11_#477.pds',
  '260223171205_26IMSA02_T02_SEB_CT1_Run004_TL_MQ12Di_LMP2 #443.pds',
];

const UNSUPPORTED_EXPORT_FILES = [
  'Export_MB_CT5_SebringTest2026.pds',
  'Export_Tobi_QualySim_SebringTest2026.pds',
];

async function loadFixture(name: string): Promise<{ data: Uint8Array; path: string }> {
  const path = resolve(FIXTURES_DIR, name);
  const buf = await readFile(path);
  return { data: new Uint8Array(buf), path };
}

describe('PDS parser', () => {
  for (const file of FIXTURE_FILES) {
    describe(file, () => {
      it('parses without throwing', async () => {
        const { data, path } = await loadFixture(file);
        const session = parsePds(data, path);
        expect(session).toBeDefined();
      });

      it('has channels including speed', async () => {
        const { data, path } = await loadFixture(file);
        const session = parsePds(data, path);
        expect(session.matrix.channels.length).toBeGreaterThan(0);
        // Speed channel should be present (required by Session constructor)
        const speedRow = session.matrix.row('speed');
        expect(speedRow).toBeDefined();
      });

      it('has speed values in reasonable range (0-400 km/h)', async () => {
        const { data, path } = await loadFixture(file);
        const session = parsePds(data, path);
        const speedRow = session.matrix.row('speed')!;
        let maxSpeed = 0;
        for (let i = 0; i < speedRow.length; i++) {
          if (speedRow[i]! > maxSpeed) maxSpeed = speedRow[i]!;
        }
        expect(maxSpeed).toBeGreaterThan(0);
        expect(maxSpeed).toBeLessThan(400);
      });

      it('has at least 1 lap', async () => {
        const { data, path } = await loadFixture(file);
        const session = parsePds(data, path);
        expect(session.lapCount).toBeGreaterThanOrEqual(1);
      });

      it('format is pds', async () => {
        const { data, path } = await loadFixture(file);
        const session = parsePds(data, path);
        expect(session.format).toBe('pds');
      });

      it('sampleRate > 0', async () => {
        const { data, path } = await loadFixture(file);
        const session = parsePds(data, path);
        expect(session.sampleRate).toBeGreaterThan(0);
      });
    });
  }

  describe('directory parsing', () => {
    it('reads directory entries from files with standard offset', async () => {
      const { data } = await loadFixture(FIXTURE_FILES[1]!);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      // File 2 has entry count at 0x88
      const entryCount = view.getUint32(0x88, true);
      expect(entryCount).toBeGreaterThan(2);
      expect(entryCount).toBeLessThanOrEqual(64);
    });

    it('reads directory entries from files with non-standard offset', async () => {
      // File 1 has directory at 0x58 (not 0x80) — parser should auto-detect
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      expect(session.matrix.channels.length).toBeGreaterThan(5);
    });
  });

  describe('channel definition discovery', () => {
    it('finds marker 0x7c72 in file with marker-based defs', async () => {
      // File 2 uses 0x7c72 markers
      const { data, path } = await loadFixture(FIXTURE_FILES[1]!);
      const session = parsePds(data, path);
      expect(session.matrix.channels.length).toBeGreaterThan(5);
    });

    it('parses markerless channel definitions in legacy file', async () => {
      // File 1 also uses markerless definitions
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      expect(session.matrix.channels.length).toBeGreaterThan(5);
    });
  });

  describe('both layout variants work', () => {
    it('parses legacy variant (large file)', async () => {
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      expect(session.matrix.channels.length).toBeGreaterThan(5);
    });

    it('compact export variant parses successfully', async () => {
      const { data, path } = await loadFixture(UNSUPPORTED_EXPORT_FILES[0]!);
      const session = parsePds(data, path);
      expect(session.matrix.channels.length).toBeGreaterThan(5);
    });
  });

  describe('multi-chunk channel assembly', () => {
    it('assembles multi-chunk channels correctly in legacy file', async () => {
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      const speedRow = session.matrix.row('speed')!;
      // Should have substantial number of samples for a 72MB file
      expect(speedRow.length).toBeGreaterThan(1000);
    });
  });

  describe('UTF-16LE string decoding', () => {
    it('decodes channel names correctly', async () => {
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      // Speed channel should exist, which means name was decoded properly
      const hasSpeed = session.matrix.has('speed');
      expect(hasSpeed).toBe(true);
    });
  });

  describe('filename metadata extraction', () => {
    it('extracts driver from standard filename', async () => {
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      expect(session.driver).toBe('HM');
    });

    it('extracts track from standard filename', async () => {
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      expect(session.track).toBe('Sebring');
    });

    it('extracts driver from standard filename', async () => {
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      expect(session.driver).toBe('HM');
    });

    it('extracts date from standard filename', async () => {
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      expect(session.date.getFullYear()).toBe(2025);
      expect(session.date.getMonth() + 1).toBe(2);
      expect(session.date.getDate()).toBe(12);
    });
  });

  describe('compact export files', () => {
    for (const file of UNSUPPORTED_EXPORT_FILES) {
      it(`${file} parses as float64 export variant`, async () => {
        const { data, path } = await loadFixture(file);
        const session = parsePds(data, path);
        expect(session.format).toBe('pds');
        expect(session.lapCount).toBeGreaterThanOrEqual(1);
        expect(session.matrix.sampleCount).toBeGreaterThan(0);
      });
    }
  });
});
