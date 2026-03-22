import { describe, it, expect } from 'vitest';
import { detectVideoLapCrossings, alignLapCrossings } from '../video-extract';
import type { VideoGpsSample } from '../video-extract';

// ── S/F crossing detection ───────────────────────────────────────────

describe('detectVideoLapCrossings', () => {
  it('detects crossings when GPS track loops back', () => {
    // Simulate a simple oval: car starts near (0,0), goes around, comes back
    const gps: VideoGpsSample[] = [];
    const n = 300; // 5 min at 1Hz
    const lapLength = 100; // samples per lap

    for (let i = 0; i < n; i++) {
      const progress = (i % lapLength) / lapLength;
      const angle = progress * 2 * Math.PI;
      // Simple circle ~2km radius centered at (27.45, -81.35)
      const lat = 27.45 + 0.018 * Math.cos(angle); // ~2km
      const lon = -81.35 + 0.022 * Math.sin(angle);
      gps.push({ videoTime: i, lat, lon, speed: 50 });
    }

    const crossings = detectVideoLapCrossings(gps, undefined, undefined, 100, 500);
    // Should find ~3 crossings (at 0, 100, 200)
    expect(crossings.length).toBeGreaterThanOrEqual(2);
  });

  it('uses provided S/F coordinates', () => {
    const gps: VideoGpsSample[] = [];
    for (let i = 0; i < 200; i++) {
      const progress = (i % 100) / 100;
      const angle = progress * 2 * Math.PI;
      gps.push({
        videoTime: i,
        lat: 27.45 + 0.018 * Math.cos(angle),
        lon: -81.35 + 0.022 * Math.sin(angle),
        speed: 50,
      });
    }

    // Provide a specific S/F point (top of the circle)
    const crossings = detectVideoLapCrossings(gps, 27.468, -81.35, 100, 500);
    expect(crossings.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty for too-short GPS tracks', () => {
    const gps: VideoGpsSample[] = [
      { videoTime: 0, lat: 27.45, lon: -81.35, speed: 50 },
    ];
    expect(detectVideoLapCrossings(gps)).toEqual([]);
  });

  it('enforces minimum lap distance to avoid false crossings', () => {
    // Car lingering near S/F for 100 seconds (pit stop)
    const gps: VideoGpsSample[] = [];
    for (let i = 0; i < 100; i++) {
      gps.push({
        videoTime: i,
        lat: 27.45 + Math.random() * 0.0001,
        lon: -81.35 + Math.random() * 0.0001,
        speed: 2,
      });
    }
    const crossings = detectVideoLapCrossings(gps, 27.45, -81.35, 50, 1000);
    // Should only find 1 crossing (initial), not repeated false positives
    expect(crossings.length).toBeLessThanOrEqual(1);
  });
});

// ── Lap crossing alignment (the key sync algorithm) ──────────────────

describe('alignLapCrossings', () => {
  it('finds correct offset when video and telemetry lap times match', () => {
    // Telemetry: laps at 0s, 90s, 180s, 270s (90s per lap)
    const telCrossings = [0, 90, 180, 270];
    // Video: same laps but starting 300s into the video (long pit recording before)
    const vidCrossings = [300, 390, 480, 570];

    const result = alignLapCrossings(telCrossings, vidCrossings);
    expect(result).not.toBeNull();
    expect(result!.offset).toBeCloseTo(300, 0); // video = session + 300
    expect(result!.confidence).toBeGreaterThan(0.5);
  });

  it('handles video longer than telemetry (video has extra laps)', () => {
    // Telemetry: 3 laps starting at 0s
    const telCrossings = [0, 90, 180, 270];
    // Video: 6 laps, telemetry matches laps 3-5
    const vidCrossings = [50, 140, 230, 320, 410, 500, 590];
    // Telemetry laps: [90, 90, 90]. Video laps 3-5: [90, 90, 90]. Match!
    // Offset = vidCrossings[2] - telCrossings[0] = 230

    const result = alignLapCrossings(telCrossings, vidCrossings);
    expect(result).not.toBeNull();
    // Should find alignment where telemetry starts at video time ~230
    expect(result!.confidence).toBeGreaterThan(0.3);
  });

  it('handles slight lap time variation (real-world noise)', () => {
    // Telemetry: laps at 0, 91.2, 181.5, 272.8 (varying ~90s)
    const telCrossings = [0, 91.2, 181.5, 272.8];
    // Video: same pattern with offset 150s and tiny noise
    const vidCrossings = [150, 241.3, 331.4, 422.9];

    const result = alignLapCrossings(telCrossings, vidCrossings);
    expect(result).not.toBeNull();
    expect(result!.offset).toBeCloseTo(150, 1);
    expect(result!.confidence).toBeGreaterThan(0.5);
  });

  it('rejects when lap times dont match at all', () => {
    const telCrossings = [0, 90, 180, 270]; // 90s laps
    const vidCrossings = [0, 60, 120, 180]; // 60s laps (different track/car)

    const result = alignLapCrossings(telCrossings, vidCrossings);
    // Either null or very low confidence
    if (result) {
      expect(result.confidence).toBeLessThan(0.5);
    }
  });

  it('returns null for insufficient data', () => {
    expect(alignLapCrossings([0], [0])).toBeNull();
    expect(alignLapCrossings([], [])).toBeNull();
    expect(alignLapCrossings([0, 90], [0])).toBeNull();
  });

  it('handles telemetry that covers only part of the video', () => {
    // Video: 10 laps (1000s). Telemetry: 3 laps from the middle.
    const vidCrossings = [0, 95, 190, 285, 380, 475, 570, 665, 760, 855, 950];
    // Telemetry: laps 5-7 (times 0, 95, 190, 285 in session time)
    const telCrossings = [0, 95, 190, 285];

    const result = alignLapCrossings(telCrossings, vidCrossings);
    expect(result).not.toBeNull();
    // Should find one of the valid starting positions (0, 95, 190, etc.)
    // The offset should be a multiple of ~95 (since all laps are ~95s)
    expect(result!.confidence).toBeGreaterThan(0.3);
  });

  it('works with different S/F positions (interval matching)', () => {
    // Key insight: telemetry S/F might be at a different track position
    // than video GPS S/F. But lap INTERVALS should still match.
    //
    // Telemetry S/F at turn 1: laps [0, 88, 179, 268]
    // Video S/F at the straight: laps [15, 103, 194, 283]
    // Same intervals: [88, 91, 89] vs [88, 91, 89]
    // But the offset accounts for the S/F position difference
    const telCrossings = [0, 88, 179, 268];
    const vidCrossings = [315, 403, 494, 583]; // 300s offset + 15s S/F delta

    const result = alignLapCrossings(telCrossings, vidCrossings);
    expect(result).not.toBeNull();
    // Offset = 315 (vid first crossing - tel first crossing)
    expect(result!.offset).toBeCloseTo(315, 0);
  });
});
