/**
 * Export all fixture files as VBO + video to ./data/{year}/{car}/{track}/session-{driver}
 */
import { readdirSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parseMotec } from '../src/parsers/motec';
import { parsePds } from '../src/parsers/pds';
import { parseVbo } from '../src/parsers/vbo';
import { saveVboAndVideo } from '../src/writers/vbo';
import type { Session } from '../src/session';

const FIXTURES = join(__dirname, '..', 'fixtures');
const OUTPUT = join(__dirname, '..', 'data');

async function main() {
  const files: Array<{ path: string; format: string; parser: (data: Uint8Array, path: string) => Session | Promise<Session> }> = [];

  // Collect all fixture files
  for (const [dir, ext, parser] of [
    ['motec', '.ld', parseMotec],
    ['pds', '.pds', parsePds],
    ['vbo', '.vbo', parseVbo],
  ] as const) {
    const fixDir = join(FIXTURES, dir);
    if (!existsSync(fixDir)) continue;
    for (const f of readdirSync(fixDir).filter(f => f.endsWith(ext))) {
      files.push({
        path: join(fixDir, f),
        format: dir,
        parser: parser as any,
      });
    }
  }

  console.log(`Found ${files.length} fixture files\n`);

  for (const file of files) {
    const filename = file.path.split('/').pop()!;
    console.log(`Processing: ${filename}`);

    let session: Session;
    try {
      const { readFileSync } = await import('fs');
      const data = readFileSync(file.path);
      session = await file.parser(new Uint8Array(data), file.path);
    } catch (err: any) {
      console.log(`  SKIP: ${err.message}\n`);
      continue;
    }

    // Build output path: data/{year}/{car}/{track}/session-{driver}
    const year = session.date.getFullYear().toString();
    const car = sanitize(session.vehicle || 'unknown-car');
    const track = sanitize(session.track || 'unknown-track');
    const driverName = session.driver || (session.driverId !== null ? `driver-${session.driverId}` : 'unknown');
    const sessionName = `session-${sanitize(driverName)}`;

    const outDir = join(OUTPUT, year, car, track);
    mkdirSync(outDir, { recursive: true });

    try {
      const { vboPath, videoPaths } = saveVboAndVideo(session, outDir, sessionName);
      console.log(`  → ${vboPath}`);
      if (videoPaths.length > 0) {
        for (const vp of videoPaths) {
          console.log(`  🎬 ${vp}`);
        }
      }
      console.log(`  ${session.lapCount} laps, ${session.totalDuration.toFixed(0)}s, ${session.format}`);
    } catch (err: any) {
      console.log(`  WRITE ERROR: ${err.message}`);
    }
    console.log();
  }
}

function sanitize(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9_\-. #]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
    .slice(0, 60);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
