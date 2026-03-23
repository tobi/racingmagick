/**
 * Export all fixture files as VBO + video to ./data/{year}/{car}/{track}/session-{driver}-{source}
 */
import { readdirSync, mkdirSync, existsSync, readFileSync, writeFileSync, createReadStream, createWriteStream, realpathSync } from 'fs';
import { join, basename, extname } from 'path';
import { parseMotec } from '../src/parsers/motec';
import { parsePds } from '../src/parsers/pds';
import { parseVbo } from '../src/parsers/vbo';
import { saveVbo } from '../src/writers/vbo';
import { lint } from '../src/lint';
import type { Session } from '../src/session';

const FIXTURES = join(__dirname, '..', 'fixtures');
const OUTPUT = join(__dirname, '..', 'data');

async function main() {
  // Clean previous output
  const { rmSync } = await import('fs');
  if (existsSync(OUTPUT)) rmSync(OUTPUT, { recursive: true });

  const files: Array<{ path: string; format: string }> = [];

  for (const [dir, ext] of [['motec', '.ld'], ['pds', '.pds'], ['vbo', '.vbo']] as const) {
    const fixDir = join(FIXTURES, dir);
    if (!existsSync(fixDir)) continue;
    for (const f of readdirSync(fixDir).filter(f => f.endsWith(ext))) {
      files.push({ path: join(fixDir, f), format: dir });
    }
  }

  console.log(`Found ${files.length} fixture files\n`);

  let exported = 0, skipped = 0, errors = 0;

  for (const file of files) {
    const srcName = basename(file.path);
    console.log(`Processing: ${srcName}`);

    let session: Session;
    try {
      const data = readFileSync(file.path);
      if (file.format === 'motec') session = await parseMotec(new Uint8Array(data), file.path);
      else if (file.format === 'pds') session = parsePds(new Uint8Array(data), file.path);
      else session = parseVbo(new Uint8Array(data), file.path);
    } catch (err: any) {
      console.log(`  SKIP: ${err.message.slice(0, 80)}\n`);
      skipped++;
      continue;
    }

    // Lint check
    const issues = lint(session);
    const lintErrors = issues.filter(i => i.severity === 'error');
    if (lintErrors.length > 0) {
      console.log(`  LINT ERRORS (${lintErrors.length}):`);
      for (const e of lintErrors) console.log(`    ✗ ${e.message}`);
      console.log();
      errors++;
      continue;
    }

    // Build output path with source filename to avoid collisions
    const year = session.date.getFullYear().toString();
    const car = sanitize(session.vehicle || inferFromFilename(srcName, 'car'));
    const track = sanitize(session.track || inferFromFilename(srcName, 'track'));
    const driver = session.driver || (session.driverId != null ? `driver-${session.driverId}` : inferFromFilename(srcName, 'driver'));
    const srcTag = sanitize(basename(srcName, extname(srcName))).slice(0, 30);
    const outName = `session-${sanitize(driver)}-${srcTag}`;

    const outDir = join(OUTPUT, year, car, track);
    mkdirSync(outDir, { recursive: true });

    // Write VBO
    const vboPath = saveVbo(session, outDir, outName);
    console.log(`  → ${vboPath}`);

    // Copy video files (resolve symlinks for NAS)
    const videoDir = join(FIXTURES, file.format);
    const videoFiles = findMatchingVideos(srcName, videoDir);
    for (let i = 0; i < videoFiles.length; i++) {
      const vf = videoFiles[i]!;
      const ext = extname(vf);
      const videoOutPath = join(outDir, `${outName}_${String(i + 1).padStart(4, '0')}${ext}`);
      try {
        copyFileFollowingSymlinks(vf, videoOutPath);
        console.log(`  🎬 ${videoOutPath}`);
      } catch (err: any) {
        console.log(`  ⚠ video copy failed: ${err.message.slice(0, 60)}`);
      }
    }

    const warnings = issues.filter(i => i.severity === 'warning');
    console.log(`  ${session.lapCount} laps, ${session.totalDuration.toFixed(0)}s, ${session.format}${warnings.length ? ` (${warnings.length} warnings)` : ''}`);
    exported++;
    console.log();
  }

  console.log(`\nDone: ${exported} exported, ${skipped} skipped, ${errors} lint errors`);
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-. #]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase().slice(0, 60);
}

/** Infer metadata from filename when the parser doesn't provide it. */
function inferFromFilename(filename: string, field: 'driver' | 'car' | 'track'): string {
  const base = filename.replace(/\.[^.]+$/, '');
  const tokens = base.split(/[_\-. ]+/).filter(t => t.length > 0);

  if (field === 'track') {
    // Look for known track codes
    const trackCodes: Record<string, string> = {
      seb: 'sebring', day: 'daytona', rdam: 'road-america', rdam: 'road-america',
      ims: 'indianapolis', wtk: 'watkins-glen', ctmp: 'ctmp', brb: 'barber',
      plm: 'petit-le-mans', lga: 'laguna-seca',
    };
    for (const t of tokens) {
      const code = t.toLowerCase();
      if (trackCodes[code]) return trackCodes[code]!;
    }
  }

  if (field === 'driver') {
    // Look for 2-letter initials after "Run###"
    const runIdx = tokens.findIndex(t => /^run\d+$/i.test(t));
    if (runIdx >= 0 && runIdx + 1 < tokens.length) {
      const candidate = tokens[runIdx + 1]!;
      if (candidate.length <= 3) return candidate;
    }
  }

  if (field === 'car') {
    // Look for car identifier patterns
    for (const t of tokens) {
      if (/lmp|gt[d3]|mq\d|#\d/i.test(t)) return t;
    }
  }

  return 'unknown';
}

/** Find video files matching a telemetry filename in the same directory. */
function findMatchingVideos(telemetryFilename: string, dir: string): string[] {
  const stem = telemetryFilename.replace(/\.[^.]+$/, '');
  const allFiles = readdirSync(dir).filter(f => /\.(mp4|mov|mkv|MOV)$/i.test(f));

  // Prefer keyframed, then prefix match, then fuzzy
  const results: string[] = [];
  for (const f of allFiles) {
    const vStem = f.replace(/\.[^.]+$/, '').replace(/_keyframed$/, '');
    if (vStem.startsWith(stem) || stem.startsWith(vStem.replace(/_\d{4}$/, ''))) {
      // Prefer keyframed version
      const kf = f.replace(/\.(mp4|mov|MOV)$/i, '_keyframed.mp4');
      if (allFiles.includes(kf)) {
        if (!results.includes(join(dir, kf))) results.push(join(dir, kf));
      } else {
        results.push(join(dir, f));
      }
    }
  }
  return results;
}

/** Copy a file, resolving symlinks first (works with NAS symlinks). */
function copyFileFollowingSymlinks(src: string, dst: string): void {
  let realSrc: string;
  try {
    realSrc = realpathSync(src);
  } catch {
    realSrc = src;
  }

  // Stream copy to handle large files
  return new Promise<void>((resolve, reject) => {
    const rd = createReadStream(realSrc);
    const wr = createWriteStream(dst);
    rd.on('error', reject);
    wr.on('error', reject);
    wr.on('finish', resolve);
    rd.pipe(wr);
  }) as any;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
