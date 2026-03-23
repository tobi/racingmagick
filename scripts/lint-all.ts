import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseMotec } from '../src/parsers/motec';
import { parsePds } from '../src/parsers/pds';
import { parseVbo } from '../src/parsers/vbo';
import { lint } from '../src/lint';
import type { Session } from '../src/session';

const FIXTURES = 'fixtures';

async function main() {
  const files: Array<{path: string; fmt: string}> = [
    ...readdirSync(join(FIXTURES,'motec')).filter(f=>f.endsWith('.ld')).map(f=>({path:join(FIXTURES,'motec',f),fmt:'motec'})),
    ...readdirSync(join(FIXTURES,'pds')).filter(f=>f.endsWith('.pds')).map(f=>({path:join(FIXTURES,'pds',f),fmt:'pds'})),
    ...readdirSync(join(FIXTURES,'vbo')).filter(f=>f.endsWith('.vbo')).map(f=>({path:join(FIXTURES,'vbo',f),fmt:'vbo'})),
  ];

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const {path, fmt} of files) {
    const name = path.split('/').pop()!;
    try {
      const buf = new Uint8Array(readFileSync(path));
      let session: Session;
      if (fmt === 'motec') session = await parseMotec(buf, path);
      else if (fmt === 'pds') session = parsePds(buf, path);
      else session = parseVbo(buf, path);

      const issues = lint(session);
      const errors = issues.filter(i => i.severity === 'error');
      const warnings = issues.filter(i => i.severity === 'warning');
      totalErrors += errors.length;
      totalWarnings += warnings.length;

      const speedRow = session.matrix.row('speed');
      const thrRow = session.matrix.row('throttle');
      let sMax = 0, tMax = 0;
      if (speedRow) for (let i = 0; i < speedRow.length; i++) if (speedRow[i]! > sMax && isFinite(speedRow[i]!)) sMax = speedRow[i]!;
      if (thrRow) for (let i = 0; i < thrRow.length; i++) if (thrRow[i]! > tMax && isFinite(thrRow[i]!)) tMax = thrRow[i]!;

      const status = errors.length > 0 ? '✗' : warnings.length > 0 ? '⚠' : '✓';
      console.log(`${status} ${name.padEnd(55)} ${session.lapCount} laps  spd:${sMax.toFixed(0).padStart(4)}  thr:${tMax.toFixed(2)}  ${errors.length}err ${warnings.length}warn`);
      for (const e of errors) console.log(`    ✗ ${e.message}`);
      for (const w of warnings) console.log(`    ⚠ ${w.message}`);
    } catch (e: any) {
      console.log(`✗ ${name.padEnd(55)} THROW: ${e.message.slice(0, 100)}`);
    }
  }

  console.log(`\n${totalErrors} errors, ${totalWarnings} warnings`);
}

main();
