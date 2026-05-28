import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveVbo } from '../writers/vbo';
import { parseMotec } from '../parsers/motec';
import { parsePds } from '../parsers/pds';
import { parseVbo } from '../parsers/vbo';

const FIXTURES = join(__dirname, '../../fixtures');
const fixtureExists = (...parts: string[]) => existsSync(join(FIXTURES, ...parts));
const itIfFixture = (...parts: string[]) => fixtureExists(...parts) ? it : it.skip;

describe('VBO writer', () => {
  itIfFixture('motec', 'Oreca07_2024_Sebring_Test_2_MJ_FL.ld')('converts MoTeC to VBO and re-parses it', async () => {
    const data = readFileSync(join(FIXTURES, 'motec', 'Oreca07_2024_Sebring_Test_2_MJ_FL.ld'));
    const session = await parseMotec(new Uint8Array(data),
      join(FIXTURES, 'motec', 'Oreca07_2024_Sebring_Test_2_MJ_FL.ld'));

    const tmp = mkdtempSync(join(tmpdir(), 'racingmagick-vbo-'));
    const vboPath = saveVbo(session, tmp, 'motec_export');

    expect(existsSync(vboPath)).toBe(true);
    const vboContent = readFileSync(vboPath, 'utf-8');

    // Verify VBO structure
    expect(vboContent).toContain('[header]');
    expect(vboContent).toContain('[data]');
    expect(vboContent).toContain('[channel units]');
    expect(vboContent).toContain('velocity kmh');
    expect(vboContent).toContain('racingmagick');

    // Re-parse the written VBO
    const reSession = parseVbo(new Uint8Array(readFileSync(vboPath)), vboPath);
    expect(reSession.format).toBe('vbo');
    expect(reSession.matrix.sampleCount).toBeGreaterThan(0);

    // Speed should survive round-trip
    const origSpeed = session.matrix.row('speed')!;
    const reSpeed = reSession.matrix.row('speed')!;
    expect(reSpeed).not.toBeNull();

    // Check that max speed is similar (within 5% due to format precision)
    let origMax = 0, reMax = 0;
    for (let i = 0; i < origSpeed.length; i++) if (origSpeed[i]! > origMax) origMax = origSpeed[i]!;
    for (let i = 0; i < reSpeed.length; i++) if (reSpeed[i]! > reMax) reMax = reSpeed[i]!;
    expect(Math.abs(origMax - reMax) / origMax).toBeLessThan(0.05);
  });

  itIfFixture('pds', '260223171205_26IMSA02_T02_SEB_CT1_Run004_TL_MQ12Di_LMP2 #443.pds')('converts PDS to VBO', () => {
    const data = readFileSync(join(FIXTURES, 'pds',
      '260223171205_26IMSA02_T02_SEB_CT1_Run004_TL_MQ12Di_LMP2 #443.pds'));
    const session = parsePds(new Uint8Array(data),
      join(FIXTURES, 'pds', '260223171205_26IMSA02_T02_SEB_CT1_Run004_TL_MQ12Di_LMP2 #443.pds'));

    const tmp = mkdtempSync(join(tmpdir(), 'racingmagick-vbo-'));
    const vboPath = saveVbo(session, tmp, 'pds_export');

    const vboContent = readFileSync(vboPath, 'utf-8');
    expect(vboContent).toContain('[header]');
    expect(vboContent).toContain('[data]');

    // Should have ECU channels (those with valid data)
    expect(vboContent).toContain('Throttle_Pedal');
    expect(vboContent).toContain('Steering_Angle');
  });

  itIfFixture('pds', '260223171205_26IMSA02_T02_SEB_CT1_Run004_TL_MQ12Di_LMP2 #443.pds')('exported VBO has no extreme values that break Circuit Tools', async () => {
    // PDS files can have garbage sentinel values (-700 bar, 8M bar) that
    // Circuit Tools rejects. The writer must filter or clamp them.
    const data = readFileSync(join(FIXTURES, 'pds',
      '260223171205_26IMSA02_T02_SEB_CT1_Run004_TL_MQ12Di_LMP2 #443.pds'));
    const session = parsePds(new Uint8Array(data),
      join(FIXTURES, 'pds', '260223171205_26IMSA02_T02_SEB_CT1_Run004_TL_MQ12Di_LMP2 #443.pds'));

    const tmp = mkdtempSync(join(tmpdir(), 'racingmagick-vbo-'));
    const vboPath = saveVbo(session, tmp, 'sanity_test');
    const content = readFileSync(vboPath, 'utf-8');

    // Parse all data lines and check every ECU value
    const lines = content.split('\n');
    const dataStart = lines.indexOf('[data]');
    let extremeCount = 0;
    for (let i = dataStart + 1; i < lines.length; i++) {
      const fields = lines[i]!.trim().split(/\s+/);
      if (fields.length < 11) continue;
      for (let j = 10; j < fields.length; j++) {
        const v = parseFloat(fields[j]!);
        if (isFinite(v) && Math.abs(v) > 99999) extremeCount++;
      }
    }
    expect(extremeCount).toBe(0);
  });

  itIfFixture('vbo', '25IT04_RdAm_PT2_Run01_RD.vbo')('round-trips VBO → VBO', () => {
    const origData = readFileSync(join(FIXTURES, 'vbo', '25IT04_RdAm_PT2_Run01_RD.vbo'));
    const session = parseVbo(new Uint8Array(origData),
      join(FIXTURES, 'vbo', '25IT04_RdAm_PT2_Run01_RD.vbo'));

    const tmp = mkdtempSync(join(tmpdir(), 'racingmagick-vbo-'));
    const vboPath = saveVbo(session, tmp, 'roundtrip');

    const reSession = parseVbo(new Uint8Array(readFileSync(vboPath)), vboPath);

    // Duration should be similar (within 2s from resampling precision)
    expect(Math.abs(reSession.totalDuration - session.totalDuration)).toBeLessThan(2);

    // Speed data should survive round-trip
    const origSpeed = session.matrix.row('speed')!;
    const reSpeed = reSession.matrix.row('speed')!;
    let origMax = 0, reMax = 0;
    for (let i = 0; i < origSpeed.length; i++) if (origSpeed[i]! > origMax) origMax = origSpeed[i]!;
    for (let i = 0; i < reSpeed.length; i++) if (reSpeed[i]! > reMax) reMax = reSpeed[i]!;
    expect(Math.abs(origMax - reMax) / origMax).toBeLessThan(0.05);
  });

  itIfFixture('vbo', '25IT04_RdAm_PT2_Run01_RD.vbo')('includes GPS coordinates in NMEA format', async () => {
    // VBO files with GPS should export GPS in NMEA format
    const data = readFileSync(join(FIXTURES, 'vbo', '25IT04_RdAm_PT2_Run01_RD.vbo'));
    const session = parseVbo(new Uint8Array(data),
      join(FIXTURES, 'vbo', '25IT04_RdAm_PT2_Run01_RD.vbo'));

    const tmp = mkdtempSync(join(tmpdir(), 'racingmagick-vbo-'));
    const vboPath = saveVbo(session, tmp, 'gps_test');

    const content = readFileSync(vboPath, 'utf-8');
    const dataSection = content.split('[data]')[1]!;
    const firstLine = dataSection.trim().split('\n')[0]!;

    // Should have latitude/longitude values that look like NMEA
    expect(firstLine).toMatch(/[+-]\d{2,4}\.\d+/); // NMEA-like coordinates
  });

  itIfFixture('motec', 'Oreca07_2024_Sebring_Test_2_MJ_FL.ld')('includes driver/vehicle/track in comments', async () => {
    const data = readFileSync(join(FIXTURES, 'motec', 'Oreca07_2024_Sebring_Test_2_MJ_FL.ld'));
    const session = await parseMotec(new Uint8Array(data),
      join(FIXTURES, 'motec', 'Oreca07_2024_Sebring_Test_2_MJ_FL.ld'));

    const tmp = mkdtempSync(join(tmpdir(), 'racingmagick-vbo-'));
    const vboPath = saveVbo(session, tmp, 'metadata_test');

    const content = readFileSync(vboPath, 'utf-8');
    expect(content).toContain('Mikkel Jensen');
  });
});
