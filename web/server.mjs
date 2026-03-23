/**
 * RacingMagick Inspector — development server.
 *
 * Parses all fixture files on startup using the racingmagick library,
 * serves a JSON API for the inspector UI, and proxies video files.
 */

import { createServer } from 'http';
import { readFileSync, existsSync, statSync, createReadStream } from 'fs';
import { join, extname, resolve } from 'path';
import { readdirSync } from 'fs';

// Dynamic import of our library (TypeScript via tsx)
const ROOT = resolve(import.meta.dirname, '..');
const FIXTURES = join(ROOT, 'fixtures');

// We'll use tsx to run our TS code
async function loadParser() {
  const lib = await import('../src/index.ts');
  return lib;
}

async function parseAllFixtures(lib) {
  const sessions = [];

  const formats = [
    { dir: 'motec', ext: '.ld', parser: 'parseMoTeC' },
    { dir: 'pds', ext: '.pds', parser: 'parsePDS' },
    { dir: 'vbo', ext: '.vbo', parser: 'parseVBO' },
  ];

  for (const fmt of formats) {
    const dir = join(FIXTURES, fmt.dir);
    if (!existsSync(dir)) continue;

    const files = readdirSync(dir).filter(f => f.endsWith(fmt.ext));
    for (const file of files) {
      const fullPath = join(dir, file);
      console.log(`  Parsing ${fmt.dir}/${file}...`);
      try {
        const session = await lib[fmt.parser](fullPath);
        const info = extractSessionInfo(session, fullPath, fmt.dir);
        sessions.push(info);
        console.log(`    ✓ ${info.lapCount} laps, ${info.channelCount} channels, ${info.sampleRate}Hz`);
      } catch (err) {
        console.log(`    ✗ ${err.message}`);
        sessions.push({
          file: file,
          path: fullPath,
          format: fmt.dir,
          error: err.message,
        });
      }
    }
  }

  return sessions;
}

let scoreFilenameMatch; // set after lib loads

function extractSessionInfo(session, fullPath, formatDir) {
  const matrix = session.matrix;
  const channels = [...matrix.nameToIndex.keys()].filter(n => n.length > 0);

  // Extract a few key traces for visualization (downsample to max 2000 points)
  const traces = {};
  const maxPoints = 2000;
  const step = Math.max(1, Math.floor(matrix.sampleCount / maxPoints));
  const traceLength = Math.ceil(matrix.sampleCount / step);

  for (const ch of ['speed', 'throttle', 'brakePressure', 'rpm', 'gLat', 'gLong', 'steering', 'gear']) {
    const row = matrix.row(ch);
    if (!row) continue;
    const downsampled = new Array(traceLength);
    for (let i = 0; i < traceLength; i++) {
      downsampled[i] = row[i * step] ?? 0;
    }
    traces[ch] = downsampled;
  }

  // Time trace
  const timeRow = matrix.row('time');
  if (timeRow) {
    const downsampled = new Array(traceLength);
    for (let i = 0; i < traceLength; i++) {
      downsampled[i] = timeRow[i * step] ?? 0;
    }
    traces.time = downsampled;
  }

  // GPS trace
  const latRow = matrix.row('gpsLat');
  const lonRow = matrix.row('gpsLon');
  let gpsTrace = null;
  if (latRow && lonRow) {
    const gpsStep = Math.max(1, Math.floor(matrix.sampleCount / 1000));
    gpsTrace = [];
    for (let i = 0; i < matrix.sampleCount; i += gpsStep) {
      if (latRow[i] !== 0 && lonRow[i] !== 0) {
        gpsTrace.push([latRow[i], lonRow[i]]);
      }
    }
  }

  // Video info
  let videoFiles = [];
  if (session.video && session.video.files) {
    videoFiles = session.video.files.map(f => ({
      path: f.path,
      filename: f.filename,
    }));
  }

  // Find video files adjacent to the telemetry file using fuzzy token matching.
  // Tokenizes filenames and scores by shared tokens (driver initials, track code,
  // session type, run number). Prefers _keyframed.mp4 when available.
  const dir = join(FIXTURES, formatDir);
  const stem = fullPath.split('/').pop().replace(/\.[^.]+$/, '');
  const allVideoFiles = readdirSync(dir)
    .filter(f => /\.(mp4|mov|mkv|avi|MOV)$/i.test(f))
    .filter(f => !f.includes('_keyframed')); // score originals, swap to keyframed later

  // Score each video: exact stem prefix match (score 50) OR fuzzy token match
  const scored = allVideoFiles.map(f => {
    const vStem = f.replace(/\.[^.]+$/, '');
    // Exact prefix: video filename starts with telemetry stem (VBO convention)
    const prefixScore = vStem.startsWith(stem) ? 50 : 0;
    const fuzzyScore = scoreFilenameMatch(stem, vStem);
    return { file: f, score: Math.max(prefixScore, fuzzyScore) };
  }).filter(s => s.score >= 3).sort((a, b) => b.score - a.score);

  // Only keep the best match (avoid false associations across sessions)
  // If the best score is a prefix match (50), also include other prefix matches.
  // Otherwise, only keep the single best fuzzy match.
  const bestScore = scored.length > 0 ? scored[0].score : 0;
  const topScored = bestScore >= 50
    ? scored.filter(s => s.score >= 50)  // all prefix matches (multi-file VBO)
    : scored.slice(0, 1);                // single best fuzzy match only

  const adjacentVideos = [];
  for (const s of topScored) {
    // Check if a keyframed version exists
    const kfName = s.file.replace(/\.(mp4|mov|mkv|avi|MOV)$/i, '_keyframed.mp4');
    const hasKf = existsSync(join(dir, kfName));
    const actualFile = hasKf ? kfName : s.file;
    adjacentVideos.push({
      path: join(dir, actualFile),
      filename: actualFile,
      url: `/video/${formatDir}/${encodeURIComponent(actualFile)}`,
      needsKeyframes: !hasKf,
      matchScore: s.score,
    });
  }

  // Per-lap traces (downsample each lap to 500 points)
  const lapDetails = session.laps.map(l => {
    const lapTraces = {};
    const lapMaxPts = 500;
    const lapStep = Math.max(1, Math.floor(l.sampleCount / lapMaxPts));
    const lapLen = Math.ceil(l.sampleCount / lapStep);

    for (const ch of ['speed', 'throttle', 'brakePressure', 'rpm', 'gLat', 'gLong', 'steering', 'gear']) {
      const row = matrix.row(ch);
      if (!row) continue;
      const arr = new Array(lapLen);
      for (let i = 0; i < lapLen; i++) {
        const idx = l.startIdx + i * lapStep;
        arr[i] = idx < l.endIdx ? (row[idx] ?? 0) : 0;
      }
      lapTraces[ch] = arr;
    }

    // Per-lap GPS
    let lapGps = null;
    if (latRow && lonRow) {
      const gStep = Math.max(1, Math.floor(l.sampleCount / 300));
      lapGps = [];
      for (let i = l.startIdx; i < l.endIdx; i += gStep) {
        if (latRow[i] !== 0 && lonRow[i] !== 0) lapGps.push([latRow[i], lonRow[i]]);
      }
    }

    return {
      index: l.lapIndex,
      number: l.lapNumber,
      label: l.displayLabel,
      kind: l.kind,
      time: l.lapTime,
      distance: l.totalDistance,
      sampleCount: l.sampleCount,
      startTime: l.startTime,
      endTime: l.endTime,
      traces: lapTraces,
      gpsTrace: lapGps,
    };
  });

  // Find fastest timed lap
  const timedLaps = lapDetails.filter(l => l.kind === 'flying' || l.kind === 'first-flying');
  const fastestTime = timedLaps.length > 0 ? Math.min(...timedLaps.map(l => l.time)) : null;

  return {
    file: fullPath.split('/').pop(),
    path: fullPath,
    format: session.format,
    driver: session.driver,
    vehicle: session.vehicle,
    track: session.track,
    date: session.date?.toISOString(),
    sampleRate: session.sampleRate,
    sampleCount: matrix.sampleCount,
    duration: session.totalDuration,
    totalDistance: session.totalDistance,
    lapCount: session.lapCount,
    channelCount: channels.length,
    channels,
    has: session.has,
    warnings: session.warnings,
    laps: lapDetails,
    fastestTime,
    traces,
    gpsTrace,
    videos: adjacentVideos,
  };
}

// ── HTTP Server ──────────────────────────────────────────────────────

async function main() {
  console.log('RacingMagick Inspector');
  console.log('Loading parser...');
  const lib = await loadParser();

  scoreFilenameMatch = lib.scoreFilenameMatch;

  console.log('Parsing fixtures...');
  const sessions = await parseAllFixtures(lib);
  console.log(`\nParsed ${sessions.length} files.\n`);

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // API: session list
    if (url.pathname === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
      return;
    }

    // Video proxy: /video/<format>/<filename>
    if (url.pathname.startsWith('/video/')) {
      const parts = url.pathname.slice(7).split('/');
      if (parts.length >= 2) {
        const videoPath = join(FIXTURES, parts[0], parts.slice(1).join('/'));
        return serveFile(videoPath, req, res);
      }
    }

    // Static files
    const staticPath = join(import.meta.dirname, url.pathname === '/' ? 'index.html' : url.pathname);
    if (existsSync(staticPath) && statSync(staticPath).isFile()) {
      return serveFile(staticPath, req, res);
    }

    res.writeHead(404);
    res.end('Not found');
  });

  const PORT = 3456;
  server.listen(PORT, () => {
    console.log(`Inspector running at http://localhost:${PORT}`);
  });
}

function serveFile(filePath, req, res) {
  if (!existsSync(filePath)) {
    // Try following symlinks
    try {
      const real = readFileSync(filePath);
    } catch {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
  }

  const ext = extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.json': 'application/json',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';

  // Range request support for video
  if (req.headers.range && (ext === '.mp4' || ext === '.mov')) {
    const stat = statSync(filePath);
    const range = req.headers.range;
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  const stat = statSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
  });
  createReadStream(filePath).pipe(res);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
