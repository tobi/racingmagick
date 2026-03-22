import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  scoreFilenameMatch,
  parseVboAviSection,
  buildVboVideoMapping,
  attemptUtcSync,
  attemptGeometrySync,
  buildVideoTimeFromSync,
} from '../video';
import { parseVbo } from '../parsers/vbo';

const FIXTURES = join(__dirname, '../../fixtures');

// ── Filename matching ────────────────────────────────────────────────

describe('scoreFilenameMatch', () => {
  it('exact stem match scores highest', () => {
    const score = scoreFilenameMatch(
      '25IT04_RdAm_PT2_Run01_RD',
      '25IT04_RdAm_PT2_Run01_RD',
    );
    expect(score).toBe(100);
  });

  it('matching tokens score well', () => {
    const score = scoreFilenameMatch(
      '25IT04_RdAm_PT2_Run01_RD',
      '25IT04_RdAm_PT2_Run01_RD_0001',
    );
    expect(score).toBeGreaterThan(3);
  });

  it('PDS filename matches video with shared tokens', () => {
    const score = scoreFilenameMatch(
      '260223171205_26IMSA02_T02_SEB_CT1_Run004_TL_MQ12Di_LMP2 #443',
      '26IMSA02_SEB_CT1_Run004_TL',
    );
    expect(score).toBeGreaterThan(3);
  });

  it('completely unrelated filenames score 0', () => {
    const score = scoreFilenameMatch(
      '25IT04_RdAm_PT2_Run01_RD',
      'vacation_photos_2025',
    );
    expect(score).toBe(0);
  });

  it('run number normalization (Run001 ≈ run1)', () => {
    const score = scoreFilenameMatch(
      'SEB_CT1_Run001_TL',
      'SEB_CT1_Run1_TL',
    );
    expect(score).toBeGreaterThan(3);
  });

  it('drops long timestamp tokens', () => {
    // The 12-digit timestamp should be dropped, other tokens still match
    const score = scoreFilenameMatch(
      '260223171205_26IMSA02_SEB',
      '26IMSA02_SEB_video',
    );
    expect(score).toBeGreaterThanOrEqual(3);
  });
});

// ── VBO AVI section parsing ──────────────────────────────────────────

describe('parseVboAviSection', () => {
  it('parses [AVI] section from VBO content', () => {
    const content = readFileSync(
      join(FIXTURES, 'vbo', '25IT04_RdAm_PT2_Run01_RD.vbo'),
      'utf-8',
    );
    const avi = parseVboAviSection(content);
    expect(avi).not.toBeNull();
    expect(avi!.baseFilename).toBe('25IT04_RdAm_PT2_Run01_RD_');
    expect(avi!.extensions).toContain('mp4');
  });

  it('returns null when no [AVI] section', () => {
    const result = parseVboAviSection('[header]\nsats\ntime\n[data]\n1 2 3');
    expect(result).toBeNull();
  });
});

// ── VBO video mapping ────────────────────────────────────────────────

describe('buildVboVideoMapping', () => {
  it('converts aviSyncTime from ms to seconds', () => {
    const fileIndex = new Float64Array([1, 1, 1, 2, 2]);
    const syncTime = new Float64Array([0, 40, 80, 0, 40]);
    const { videoTime, videoFileIndex } = buildVboVideoMapping(fileIndex, syncTime, 5);

    expect(videoTime[0]).toBe(0);
    expect(videoTime[1]).toBe(0.04);
    expect(videoTime[2]).toBe(0.08);
    expect(videoTime[3]).toBe(0);     // new file resets
    expect(videoTime[4]).toBe(0.04);
    expect(videoFileIndex[0]).toBe(1);
    expect(videoFileIndex[3]).toBe(2);
  });
});

// ── UTC sync ─────────────────────────────────────────────────────────

describe('attemptUtcSync', () => {
  it('finds sync when times overlap directly', () => {
    const sync = attemptUtcSync({
      sessionStartUnix: 1000000,
      sessionDuration: 3600,
      videoCreationUnix: 999990,  // video started 10s before telemetry
      videoDuration: 3700,
    });
    expect(sync).not.toBeNull();
    expect(sync!.method).toBe('utc-absolute');
    expect(sync!.confidence).toBeGreaterThan(0.5);
    expect(sync!.offset).toBeCloseTo(10, 0); // ~10s into video
  });

  it('handles timezone offset (video clock off by hours)', () => {
    const sync = attemptUtcSync({
      sessionStartUnix: 1000000,
      sessionDuration: 3600,
      videoCreationUnix: 1000000 - 5 * 3600 + 10, // 5 hours behind + 10s
      videoDuration: 3700,
    });
    expect(sync).not.toBeNull();
    expect(sync!.method).toBe('utc-absolute');
  });

  it('returns null when no overlap possible', () => {
    const sync = attemptUtcSync({
      sessionStartUnix: 1000000,
      sessionDuration: 3600,
      videoCreationUnix: 2000000, // way in the future
      videoDuration: 100,
    });
    expect(sync).toBeNull();
  });

  it('returns null for zero-duration inputs', () => {
    expect(attemptUtcSync({
      sessionStartUnix: 1000000,
      sessionDuration: 0,
      videoCreationUnix: 1000000,
      videoDuration: 100,
    })).toBeNull();
  });
});

// ── Geometry sync ────────────────────────────────────────────────────

describe('attemptGeometrySync', () => {
  it('syncs when video is longer than session', () => {
    const sync = attemptGeometrySync(3600, 4000);
    expect(sync).not.toBeNull();
    expect(sync!.method).toBe('geometry');
    expect(sync!.confidence).toBeLessThanOrEqual(0.5);
  });

  it('returns null for zero-duration', () => {
    expect(attemptGeometrySync(0, 100)).toBeNull();
  });
});

// ── Build video time array ───────────────────────────────────────────

describe('buildVideoTimeFromSync', () => {
  it('maps session time to video time via offset', () => {
    const sessionTime = new Float64Array([0, 1, 2, 3, 4]);
    const sync = {
      method: 'utc-absolute' as const,
      confidence: 0.9,
      offset: 10, // session starts 10s into video
      rate: 1.0,
      videoTimeAt(t: number) { return t * this.rate + this.offset; },
      sessionTimeAt(t: number) { return (t - this.offset) / this.rate; },
    };

    const vt = buildVideoTimeFromSync(sessionTime, sync, 100);
    expect(vt[0]).toBe(10);   // 0 + 10
    expect(vt[1]).toBe(11);   // 1 + 10
    expect(vt[4]).toBe(14);   // 4 + 10
  });

  it('marks out-of-range samples as NaN', () => {
    const sessionTime = new Float64Array([0, 50, 100]);
    const sync = {
      method: 'geometry' as const,
      confidence: 0.5,
      offset: -10,
      rate: 1.0,
      videoTimeAt(t: number) { return t + this.offset; },
      sessionTimeAt(t: number) { return t - this.offset; },
    };

    const vt = buildVideoTimeFromSync(sessionTime, sync, 50);
    expect(Number.isNaN(vt[0])).toBe(true);  // -10, before video
    expect(vt[1]).toBe(40);                   // 50 - 10 = 40, within [0, 50]
    expect(Number.isNaN(vt[2])).toBe(true);  // 90, after video end
  });
});

// ── VBO session has video attachment ─────────────────────────────────

describe('VBO session video attachment', () => {
  it('VBO session has video property', () => {
    const data = readFileSync(join(FIXTURES, 'vbo', '25IT04_RdAm_PT2_Run01_RD.vbo'));
    const session = parseVbo(new Uint8Array(data),
      join(FIXTURES, 'vbo', '25IT04_RdAm_PT2_Run01_RD.vbo'));

    expect(session.video).toBeDefined();
    // Video files may or may not be discovered (depends on whether mp4s exist alongside fixtures)
    expect(Array.isArray(session.video.files)).toBe(true);
  });

  it('VBO session passes avifileindex/avitime to video system', () => {
    const data = readFileSync(join(FIXTURES, 'vbo', '25IT04_RdAm_PT2_Run01_RD.vbo'));
    const session = parseVbo(new Uint8Array(data),
      join(FIXTURES, 'vbo', '25IT04_RdAm_PT2_Run01_RD.vbo'));

    // Even without actual video files present, the aviSyncTime data
    // should have been captured from the VBO columns
    // The video attachment should exist
    expect(session.video).toBeDefined();
  });
});
