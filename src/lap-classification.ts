import { ChannelMatrix } from './channel-matrix';
import { CH_TIME, CH_DISTANCE, CH_SPEED, CH_TRACK_POSITION } from './types';
import { LapKind } from './types';
import type { LapInfo, LapBoundary, PositionSource, CircuitInfo, SectorTime, TimingLine } from './types';
import { PIT_SPEED_THRESHOLD_KMH, MIN_MOVING_SPEED_KMH, MIN_LAP_DURATION_S } from './constants';
import { haversine } from './gps';

interface LapRange {
  startIdx: number;
  endIdx: number;
}

/**
 * Classify a single lap based on speed patterns.
 */
export function classifyLap(
  lap: LapRange,
  matrix: ChannelMatrix,
  prevLap: { kind: LapKind } | null,
  pitSpeedThreshold: number = PIT_SPEED_THRESHOLD_KMH,
): LapKind {
  const speed = matrix.channels[CH_SPEED];
  const n = lap.endIdx - lap.startIdx;
  if (n <= 0) return LapKind.Slow;

  const lapDuration = n / matrix.sampleRate;

  // Sample speed at start and end (~1s window to avoid noise)
  const windowSize = Math.min(matrix.sampleRate, Math.floor(n / 4));
  if (windowSize <= 0) return LapKind.Slow;

  let startSpeedSum = 0, endSpeedSum = 0;
  for (let i = 0; i < windowSize; i++) {
    startSpeedSum += speed[lap.startIdx + i];
    endSpeedSum += speed[lap.endIdx - 1 - i];
  }
  const startSpeed = startSpeedSum / windowSize;
  const endSpeed = endSpeedSum / windowSize;

  // Check carOnJack channel
  const carOnJack = matrix.row('carOnJack');
  if (carOnJack) {
    let jackSamples = 0;
    for (let i = lap.startIdx; i < lap.endIdx; i++) {
      if (carOnJack[i] > 0.5) jackSamples++;
    }
    if (jackSamples > n * 0.1) {
      return LapKind.InLap;
    }
  }

  // Min speed during lap
  let minSpeed = Infinity;
  for (let i = lap.startIdx; i < lap.endIdx; i++) {
    if (speed[i] < minSpeed) minSpeed = speed[i];
  }

  // Out-lap: starts slow, ends at racing speed
  if (startSpeed < pitSpeedThreshold && endSpeed > pitSpeedThreshold) {
    return LapKind.OutLap;
  }

  // In-lap: starts at racing speed, ends slow
  if (startSpeed > pitSpeedThreshold && endSpeed < pitSpeedThreshold) {
    return LapKind.InLap;
  }

  // Slow lap: very slow and >30s
  if (minSpeed < MIN_MOVING_SPEED_KMH && lapDuration > MIN_LAP_DURATION_S) {
    return LapKind.Slow;
  }

  // Partial lap: too short to be real (<30s). These are fragments at
  // session start/end where recording was cut mid-lap.
  if (lapDuration < MIN_LAP_DURATION_S) {
    return LapKind.Slow;
  }

  // First flying: previous was out-lap
  if (prevLap?.kind === LapKind.OutLap) {
    return LapKind.FirstFlying;
  }

  return LapKind.Flying;
}

/**
 * Build lap info objects from boundaries and a classified matrix.
 */
export function buildLaps(
  matrix: ChannelMatrix,
  boundaries: LapBoundary[],
  positionSource: PositionSource,
  circuit?: CircuitInfo | null,
): LapInfo[] {
  if (boundaries.length < 2) {
    // Entire session is one lap
    const sampleCount = matrix.sampleCount;
    if (sampleCount === 0) return [];

    const duration = matrix.duration;
    const timeChannel = matrix.channels[CH_TIME];
    const distChannel = matrix.channels[CH_DISTANCE];
    return [{
      lapIndex: 0,
      lapNumber: 1,
      displayLabel: 'L1',
      kind: LapKind.Flying,
      lapTime: duration * 1000,
      startTime: timeChannel[0],
      endTime: timeChannel[sampleCount - 1],
      sampleRate: matrix.sampleRate,
      sampleCount,
      totalDistance: distChannel[sampleCount - 1] - distChannel[0],
      startIdx: 0,
      endIdx: sampleCount,
      sectors: null,
      positionSource,
    }];
  }

  // Convert boundary times to sample indices
  const timeChannel = matrix.channels[CH_TIME];
  const indices: number[] = [];
  for (const b of boundaries) {
    if (b.sampleIndex !== undefined) {
      indices.push(b.sampleIndex);
    } else {
      // Binary search for the closest sample
      indices.push(findClosestIndex(timeChannel, b.timeSeconds));
    }
  }

  // Build raw laps
  const rawLaps: LapRange[] = [];
  for (let i = 0; i < indices.length - 1; i++) {
    const startIdx = indices[i];
    const endIdx = indices[i + 1];
    if (endIdx > startIdx) {
      rawLaps.push({ startIdx, endIdx });
    }
  }

  // Classify each lap
  const kinds: LapKind[] = [];
  for (let i = 0; i < rawLaps.length; i++) {
    const prev = i > 0 ? { kind: kinds[i - 1] } : null;
    kinds.push(classifyLap(rawLaps[i], matrix, prev));
  }

  // Assign lap numbers (flying laps only)
  let flyingCount = 0;
  const laps: LapInfo[] = [];
  const distChannel = matrix.channels[CH_DISTANCE];

  for (let i = 0; i < rawLaps.length; i++) {
    const { startIdx, endIdx } = rawLaps[i];
    const kind = kinds[i];
    const isTimed = kind === LapKind.Flying || kind === LapKind.FirstFlying;

    if (isTimed) flyingCount++;

    const lapNumber = isTimed ? flyingCount : null;
    let displayLabel: string;
    switch (kind) {
      case LapKind.OutLap: displayLabel = 'OUT'; break;
      case LapKind.InLap: displayLabel = 'IN'; break;
      case LapKind.Slow: displayLabel = 'SLOW'; break;
      default: displayLabel = `L${flyingCount}`; break;
    }

    const startTime = timeChannel[startIdx];
    const endTime = timeChannel[endIdx - 1];
    const totalDistance = distChannel[endIdx - 1] - distChannel[startIdx];

    // Compute sector times if timing lines are available
    const sectors = isTimed && circuit?.timingLines && circuit.timingLines.length > 0
      ? computeSectorTimes(matrix, startIdx, endIdx, circuit.timingLines)
      : null;

    laps.push({
      lapIndex: i,
      lapNumber,
      displayLabel,
      kind,
      lapTime: (endTime - startTime) * 1000,
      startTime,
      endTime,
      sampleRate: matrix.sampleRate,
      sampleCount: endIdx - startIdx,
      totalDistance,
      startIdx,
      endIdx,
      sectors,
      positionSource,
    });
  }

  return laps;
}

function findClosestIndex(sortedArr: Float64Array, target: number): number {
  let lo = 0;
  let hi = sortedArr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedArr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  // Check if lo-1 is closer
  if (lo > 0 && Math.abs(sortedArr[lo - 1] - target) < Math.abs(sortedArr[lo] - target)) {
    return lo - 1;
  }
  return lo;
}

/**
 * Compute sector times from timing lines within a lap range.
 * Uses GPS coordinates to detect when the car crosses each split line.
 */
export function computeSectorTimes(
  matrix: ChannelMatrix,
  startIdx: number,
  endIdx: number,
  timingLines: ReadonlyArray<TimingLine>,
): SectorTime[] | null {
  const latRow = matrix.row('gpsLat');
  const lonRow = matrix.row('gpsLon');
  if (!latRow || !lonRow) return null;

  const splits = timingLines.filter(tl => tl.type === 'split');
  if (splits.length === 0) return null;

  const timeChannel = matrix.channels[CH_TIME];
  const tpChannel = matrix.channels[CH_TRACK_POSITION];

  // Find the crossing index for each split line
  const crossings: Array<{ splitIdx: number; sampleIdx: number; name: string }> = [];

  for (let s = 0; s < splits.length; s++) {
    const line = splits[s];
    const lineMidLat = (line.start.lat + line.end.lat) / 2;
    const lineMidLon = (line.start.lon + line.end.lon) / 2;

    // Find the sample closest to this timing line
    let bestDist = Infinity;
    let bestIdx = -1;
    for (let i = startIdx; i < endIdx; i++) {
      const dist = haversine(latRow[i], lonRow[i], lineMidLat, lineMidLon);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    // Only accept crossings within 50m of the line
    if (bestIdx >= 0 && bestDist < 50) {
      crossings.push({ splitIdx: s, sampleIdx: bestIdx, name: line.name });
    }
  }

  if (crossings.length === 0) return null;

  // Sort crossings by sample index (order around the track)
  crossings.sort((a, b) => a.sampleIdx - b.sampleIdx);

  // Build sector times: from lap start → first split, between splits, last split → lap end
  const sectors: SectorTime[] = [];
  let prevIdx = startIdx;
  let prevPosition = tpChannel[startIdx];

  for (let c = 0; c < crossings.length; c++) {
    const crossing = crossings[c];
    const sectorStart = prevPosition;
    const sectorEnd = tpChannel[crossing.sampleIdx];
    const sectorTime = (timeChannel[crossing.sampleIdx] - timeChannel[prevIdx]) * 1000;

    sectors.push({
      sector: c + 1,
      name: crossing.name || `S${c + 1}`,
      time: sectorTime,
      startPosition: sectorStart,
      endPosition: sectorEnd,
    });

    prevIdx = crossing.sampleIdx;
    prevPosition = sectorEnd;
  }

  // Final sector: last split → lap end
  const lastSectorTime = (timeChannel[endIdx - 1] - timeChannel[prevIdx]) * 1000;
  sectors.push({
    sector: sectors.length + 1,
    name: `S${sectors.length + 1}`,
    time: lastSectorTime,
    startPosition: prevPosition,
    endPosition: tpChannel[endIdx - 1],
  });

  return sectors;
}
