import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';
import { parseVbo, vboTimeToSeconds } from '../parsers/vbo';

const FIXTURES_DIR = resolve(__dirname, '../../fixtures/vbo');

async function loadFixture(name: string) {
  const data = await readFile(resolve(FIXTURES_DIR, name));
  return parseVbo(new Uint8Array(data), name);
}

// ── Time parsing ─────────────────────────────────────────────────────

describe('vboTimeToSeconds', () => {
  it('parses HHMMSS.mmm correctly', () => {
    // 13:10:23.480
    expect(vboTimeToSeconds(131023.480)).toBeCloseTo(
      13 * 3600 + 10 * 60 + 23.48,
      3,
    );
  });

  it('parses midnight', () => {
    expect(vboTimeToSeconds(0)).toBe(0);
  });

  it('parses single-digit hours', () => {
    // 08:18:17.500
    expect(vboTimeToSeconds(81817.5)).toBeCloseTo(
      8 * 3600 + 18 * 60 + 17.5,
      3,
    );
  });
});

// ── Per-fixture tests ────────────────────────────────────────────────

const ALL_FIXTURES = [
  '25IT04_RdAm_PT2_Run01_RD.vbo',
  '25IT04_RdAm_PT2_Run02_TL.vbo',
  'ERA_081_2024_11_19_105252_0001.vbo',
  'ERA_081_2025_01_06_081816_0001.vbo',
  'VBOX202502140908250001.vbo',
  'VBOX202502140912340001.vbo',
];

const FIXTURES = ALL_FIXTURES.filter((name) => existsSync(resolve(FIXTURES_DIR, name)));
const itIfFixture = (name: string) => existsSync(resolve(FIXTURES_DIR, name)) ? it : it.skip;

describe.each(FIXTURES)('parseVbo(%s)', (filename) => {
  it('parses without throwing', async () => {
    await expect(loadFixture(filename)).resolves.toBeDefined();
  });

  it('has at least 1 lap', async () => {
    const session = await loadFixture(filename);
    expect(session.lapCount).toBeGreaterThanOrEqual(1);
  });

  it('has speed values in a reasonable range', async () => {
    const session = await loadFixture(filename);
    const speedRow = session.matrix.row('speed');
    expect(speedRow).not.toBeNull();
    let maxSpeed = 0;
    for (let i = 0; i < speedRow!.length; i++) {
      if (speedRow![i] > maxSpeed) maxSpeed = speedRow![i];
    }
    // Speed should be between 0 and 400 km/h for racing
    expect(maxSpeed).toBeGreaterThan(0);
    expect(maxSpeed).toBeLessThan(400);
  });

  it('has throttle in 0.0–1.0 range', async () => {
    const session = await loadFixture(filename);
    const throttleRow = session.matrix.row('throttle');
    expect(throttleRow).not.toBeNull();
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < throttleRow!.length; i++) {
      const v = throttleRow![i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeGreaterThanOrEqual(-0.01); // small tolerance
    expect(max).toBeLessThanOrEqual(1.01);
  });

  it('has format vbo', async () => {
    const session = await loadFixture(filename);
    expect(session.format).toBe('vbo');
  });

  it('has sampleRate > 0', async () => {
    const session = await loadFixture(filename);
    expect(session.sampleRate).toBeGreaterThan(0);
  });

  it('has correct GPS channel availability', async () => {
    const session = await loadFixture(filename);
    // All VBO files should have GPS data
    expect(session.has.gps).toBe(true);
  });
});

// ── Road America fixtures specific tests ─────────────────────────────

describe('Road America fixtures', () => {
  itIfFixture('25IT04_RdAm_PT2_Run01_RD.vbo')('has circuit info', async () => {
    const session = await loadFixture('25IT04_RdAm_PT2_Run01_RD.vbo');
    expect(session.circuit).not.toBeNull();
    expect(session.circuit!.name).toBe('Road America');
    expect(session.circuit!.country).toBe('United States');
  });

  itIfFixture('25IT04_RdAm_PT2_Run01_RD.vbo')('has timing lines with splits', async () => {
    const session = await loadFixture('25IT04_RdAm_PT2_Run01_RD.vbo');
    expect(session.circuit!.timingLines.length).toBeGreaterThan(0);
    const start = session.circuit!.timingLines.find((t) => t.type === 'start');
    expect(start).toBeDefined();
  });

  itIfFixture('25IT04_RdAm_PT2_Run01_RD.vbo')('has RPM data', async () => {
    const session = await loadFixture('25IT04_RdAm_PT2_Run01_RD.vbo');
    expect(session.has.rpm).toBe(true);
  });

  itIfFixture('25IT04_RdAm_PT2_Run01_RD.vbo')('has brake pressure data', async () => {
    const session = await loadFixture('25IT04_RdAm_PT2_Run01_RD.vbo');
    expect(session.has.brakePressure).toBe(true);
  });
});

// ── ERA fixtures specific tests ──────────────────────────────────────

describe('ERA fixtures', () => {
  itIfFixture('ERA_081_2025_01_06_081816_0001.vbo')('ERA 2025 has damper data', async () => {
    const session = await loadFixture('ERA_081_2025_01_06_081816_0001.vbo');
    expect(session.has.dampers).toBe(true);
  });

  itIfFixture('ERA_081_2025_01_06_081816_0001.vbo')('ERA 2025 has wheel speed data', async () => {
    const session = await loadFixture('ERA_081_2025_01_06_081816_0001.vbo');
    expect(session.has.wheelSpeeds).toBe(true);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────

describe('edge cases', () => {
  it('throws on empty data', () => {
    expect(() => parseVbo(new Uint8Array(0), 'empty.vbo')).toThrow('Empty VBO file');
  });

  it('throws on data with no [data] section', () => {
    const text = 'File created on 01/01/2025 @ 00:00:00\n[header]\ntime\n';
    const bytes = new TextEncoder().encode(text);
    expect(() => parseVbo(bytes, 'nodata.vbo')).toThrow('No [data] section');
  });
});
