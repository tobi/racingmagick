/**
 * Data sanity linter: runs lint() on every parseable fixture.
 * Every file must have zero errors. Warnings are printed but allowed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMotec } from '../parsers/motec';
import { parsePds } from '../parsers/pds';
import { parseVbo } from '../parsers/vbo';
import { lint } from '../lint';
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
  // PDS (standard variants)
  ...['250212084750_25IMSAT02_SEB_CT1_Run001_HM_Car11_#477.pds',
    '260223171205_26IMSA02_T02_SEB_CT1_Run004_TL_MQ12Di_LMP2 #443.pds',
  ].map(f => ({
    name: `pds/${f}`,
    load: () => parsePds(new Uint8Array(readFileSync(join(FIXTURES, 'pds', f))), join(FIXTURES, 'pds', f)),
  })),
  // PDS (export variants)
  ...['Export_MB_CT5_SebringTest2026.pds',
    'Export_Tobi_QualySim_SebringTest2026.pds',
  ].map(f => ({
    name: `pds-export/${f}`,
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

describe('Lint: every fixture', () => {
  for (const fixture of ALL_FIXTURES) {
    it(`${fixture.name} — no lint errors`, async () => {
      const session = await fixture.load();
      const issues = lint(session);

      const errors = issues.filter(i => i.severity === 'error');
      const warnings = issues.filter(i => i.severity === 'warning');

      if (warnings.length > 0) {
        console.log(`  ${fixture.name} warnings:`);
        for (const w of warnings) console.log(`    ⚠ [${w.code}] ${w.message}`);
      }

      if (errors.length > 0) {
        console.log(`  ${fixture.name} ERRORS:`);
        for (const e of errors) console.log(`    ✗ [${e.code}] ${e.message}`);
      }

      // Errors are hard failures — the data is definitely wrong
      expect(errors, `Lint errors in ${fixture.name}:\n${errors.map(e => `  ${e.code}: ${e.message}`).join('\n')}`).toHaveLength(0);
    });
  }
});
