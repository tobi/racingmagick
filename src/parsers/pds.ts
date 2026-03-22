import { Session } from '../session';
import type { RawChannel, LapBoundary, SessionWarning, SessionData } from '../types';
import { ParseError } from '../types';

const TICKS_PER_SECOND = 10_000_000;

// ── UTF-16LE string reader ────────────────────────────────────────────

function readUtf16le(view: DataView, offset: number, maxBytes: number): string {
  const chars: number[] = [];
  for (let i = 0; i < maxBytes; i += 2) {
    if (offset + i + 1 >= view.byteLength) break;
    const code = view.getUint16(offset + i, true);
    if (code === 0) break;
    chars.push(code);
  }
  return String.fromCharCode(...chars).trim();
}

// ── Directory entry ───────────────────────────────────────────────────

interface DirEntry {
  offset: number;
  count: number;
  classA: number;
  classB: number;
  nextCount: number;
}

function readEntriesAt(view: DataView, start: number, count: number, fileSize: number): DirEntry[] {
  const entries: DirEntry[] = [];
  for (let i = 0; i < count; i++) {
    const base = start + i * 32;
    if (base + 32 > fileSize) break;
    const offsetLo = view.getUint32(base, true);
    const offsetHi = view.getUint32(base + 4, true);
    entries.push({
      offset: offsetLo + offsetHi * 0x100000000,
      count: view.getUint32(base + 8, true),
      classA: view.getUint32(base + 0x10, true),
      classB: view.getUint32(base + 0x14, true),
      nextCount: view.getUint32(base + 0x18, true),
    });
  }
  return entries;
}

function findDirectory(view: DataView, fileSize: number): DirEntry[] {
  // Try multiple starting offsets and pick the best one
  const candidates = [0x80, 0x78, 0x70, 0x68, 0x60, 0x58, 0x50, 0x48, 0x40];
  let bestEntries: DirEntry[] = [];
  let bestScore = -1;

  for (const start of candidates) {
    const entries = readEntriesAt(view, start, 20, fileSize);
    let score = 0;
    for (const e of entries) {
      if (e.classA <= 3 && e.classB <= 3 && e.offset > 0 && e.offset < fileSize) score += 2;
      else if (e.classA <= 3 && e.classB <= 3) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestEntries = entries;
    }
  }

  return bestEntries;
}

// ── Layout detection ──────────────────────────────────────────────────

interface Layout {
  defsOffset: number;
  defsCount: number;
  chunkOffset: number;
  nextOffset: number;
  chunkCount: number;
}

function findLayout(entries: DirEntry[], fileSize: number): Layout {
  // Scan for valid triplets: defs, chunk, next
  // defs entry should have classA==1, classB==1, and its offset section should
  // contain plausible channel definition records
  for (let i = 0; i < entries.length - 2; i++) {
    const defs = entries[i]!;
    const chunk = entries[i + 1]!;
    const next = entries[i + 2]!;

    if (defs.offset >= chunk.offset) continue;
    if (chunk.offset >= next.offset) continue;
    if (next.offset > fileSize) continue;
    if (defs.classA !== 1 || defs.classB !== 1) continue;
    if (defs.count === 0) continue;

    const span = next.offset - chunk.offset;
    if (span <= 0) continue;

    // Determine chunk count: try defs.nextCount first, then chunk.count
    let chunkCount = 0;
    if (defs.nextCount > 0) {
      const rs = span / defs.nextCount;
      if (rs >= 48 && rs <= 512 && Math.abs(rs - Math.round(rs)) < 0.01) {
        chunkCount = defs.nextCount;
      }
    }
    if (chunkCount === 0 && chunk.count > 0) {
      const rs = span / chunk.count;
      if (rs >= 48 && rs <= 512 && Math.abs(rs - Math.round(rs)) < 0.01) {
        chunkCount = chunk.count;
      }
    }
    if (chunkCount === 0) continue;

    return {
      defsOffset: defs.offset,
      defsCount: defs.count,
      chunkOffset: chunk.offset,
      nextOffset: next.offset,
      chunkCount,
    };
  }
  throw new ParseError('No valid PDS layout found in directory', 'pds');
}

// ── Channel definitions ───────────────────────────────────────────────

interface ChannelDef {
  id: number;
  name: string;
  unit: string;
  typeCode: number;
}

const MARKER = 0x7c72;

function findChannelDefs(view: DataView, layout: Layout): ChannelDef[] {
  const { defsOffset, defsCount, chunkOffset } = layout;
  const defsSpan = chunkOffset - defsOffset;

  // Strategy 1: scan for 0x7c72 marker (classic variant)
  const markerDefs = tryMarkerDefs(view, defsOffset, chunkOffset);
  if (markerDefs.length > 0) return markerDefs;

  // Strategy 2: marker-less records — compute record size from count
  if (defsCount > 0 && defsSpan > 0) {
    const recordSize = Math.floor(defsSpan / defsCount);
    if (recordSize >= 100 && recordSize <= 1024) {
      const defs = parseMarkerlessDefs(view, defsOffset, recordSize, defsCount, chunkOffset);
      if (defs.length > 0) return defs;
    }
  }

  throw new ParseError('No valid channel definitions found', 'pds');
}

function tryMarkerDefs(view: DataView, defsOffset: number, chunkOffset: number): ChannelDef[] {
  const scanLimit = chunkOffset - defsOffset;
  let markerPos = -1;

  for (let i = 0; i < scanLimit; i += 2) {
    const pos = defsOffset + i;
    if (pos + 8 > view.byteLength) break;
    if (view.getUint32(pos, true) === MARKER && view.getUint32(pos + 4, true) === 0) {
      markerPos = pos;
      break;
    }
  }

  if (markerPos < 0) return [];

  // Detect record size from gap between first two markers
  let recordSize = 304;
  for (let probe = markerPos + 16; probe < Math.min(markerPos + 1024, chunkOffset); probe += 2) {
    if (probe + 8 > view.byteLength) break;
    if (view.getUint32(probe, true) === MARKER && view.getUint32(probe + 4, true) === 0) {
      recordSize = probe - markerPos;
      break;
    }
  }

  const defs: ChannelDef[] = [];
  const limit = Math.min(chunkOffset, view.byteLength);
  for (let pos = markerPos; pos + Math.min(recordSize, 0xDC) <= limit; pos += recordSize) {
    if (view.getUint32(pos, true) !== MARKER || view.getUint32(pos + 4, true) !== 0) continue;
    const channelId = view.getUint32(pos + 0x08, true);
    if (channelId === 0) continue;
    const name = readUtf16le(view, pos + 0x10, 112);
    const unit = readUtf16le(view, pos + 0x98, 32);
    const typeCode = pos + 0xDC <= view.byteLength ? view.getUint32(pos + 0xD8, true) : 6;
    if (name.length > 0) {
      defs.push({ id: channelId, name, unit, typeCode });
    }
  }

  return defs;
}

function parseMarkerlessDefs(
  view: DataView,
  defsOffset: number,
  recordSize: number,
  count: number,
  _chunkOffset: number,
): ChannelDef[] {
  const defs: ChannelDef[] = [];
  for (let i = 0; i < count; i++) {
    const pos = defsOffset + i * recordSize;
    if (pos + 16 > view.byteLength) break;

    const channelId = view.getUint32(pos, true);
    // Name at +0x08 (UTF-16LE)
    const name = readUtf16le(view, pos + 8, 112);
    if (name.length === 0) continue;

    // Unit: try to find at standard positions, or leave empty
    let unit = '';
    if (recordSize >= 0x98 + 32) {
      unit = readUtf16le(view, pos + 0x98, 32);
    }

    // Type code: In export variant, the D0 field often has type pair info (7,7)
    // which doesn't directly map to data encoding. Default to float32 for export.
    // The actual data in export files is always float32 (verified from data gap analysis).
    let typeCode = 6; // float32 default for export variant

    // For export variant, use sequential index as ID (not file-embedded seq num)
    // so it matches the round-robin chunk assignment
    defs.push({ id: i, name, unit, typeCode });
  }

  return defs;
}

// ── Chunk records ─────────────────────────────────────────────────────

interface ChunkRecord {
  order: number;
  channelId: number;
  samplePeriodTicks: number;
  sampleCount: number;
  dataPtr: number;
}

function parseChunks(
  view: DataView,
  layout: Layout,
  fileSize: number,
): ChunkRecord[] {
  const { chunkOffset, nextOffset, chunkCount } = layout;
  const span = nextOffset - chunkOffset;
  const chunkRecordSize = Math.round(span / chunkCount);
  const chunks: ChunkRecord[] = [];

  // Try variant A: channel_id == channel_id_2 validation
  {
    let alignedOffset = chunkOffset;
    let found = false;
    for (let scan = 0; scan < Math.min(4096, span); scan += 4) {
      const probe = chunkOffset + scan;
      if (probe + 0x40 > fileSize) break;
      const cid = view.getUint32(probe + 4, true);
      const cid2 = view.getUint32(probe + 8, true);
      const sc = view.getUint32(probe + 0x1C, true);
      if (cid > 0 && cid === cid2 && sc > 0) {
        alignedOffset = probe;
        found = true;
        break;
      }
    }

    if (found) {
      for (let i = 0; i < chunkCount; i++) {
        const pos = alignedOffset + i * chunkRecordSize;
        if (pos + 0x3C > fileSize) break;
        const order = view.getUint32(pos, true);
        const channelId = view.getUint32(pos + 4, true);
        const channelId2 = view.getUint32(pos + 8, true);
        const samplePeriodTicks = view.getUint32(pos + 0x18, true);
        const sampleCount = view.getUint32(pos + 0x1C, true);
        const dataPtr = view.getUint32(pos + 0x38, true);

        if (channelId > 0 && channelId === channelId2 && sampleCount > 0 && samplePeriodTicks > 0 && dataPtr < fileSize) {
          chunks.push({ order, channelId, samplePeriodTicks, sampleCount, dataPtr });
        }
      }
      if (chunks.length > 0) return chunks;
    }
  }

  // Variant B (export): no channel_id field in chunks.
  // The data area contains all channels interleaved sample-by-sample.
  // Instead of trying to assign chunks to channels, we'll read the entire
  // data area and deinterleave by channel count in the main parser.
  const numChannels = layout.defsCount > 0 ? layout.defsCount : 1;

  // Read raw chunks to get overall data layout
  for (let i = 0; i < chunkCount; i++) {
    const pos = chunkOffset + i * chunkRecordSize;
    if (pos + chunkRecordSize > fileSize) break;

    const order = view.getUint32(pos, true);
    const samplePeriodTicks = view.getUint32(pos + 0x18, true);
    const sampleCount = view.getUint32(pos + 0x1C, true);
    const dataPtr = pos + 0x3C <= fileSize ? view.getUint32(pos + 0x38, true) : 0;

    if (sampleCount > 0 && samplePeriodTicks > 0 && dataPtr > 0 && dataPtr < fileSize) {
      // Assign channel by round-robin: each chunk covers one channel segment
      chunks.push({
        order,
        channelId: i % numChannels,
        samplePeriodTicks,
        sampleCount,
        dataPtr,
      });
    }
  }

  // Mark as export for stride-aware decoding
  (chunks as any).__exportVariant = true;
  (chunks as any).__numChannels = numChannels;

  return chunks;
}

// ── Sample decoding ───────────────────────────────────────────────────

function byteSizeForType(typeCode: number): number {
  switch (typeCode) {
    case 1: return 1;
    case 3: return 2;
    case 4: return 4;
    case 5: return 4;
    case 6: return 4;
    case 7: return 8; // float64
    default: return 4;
  }
}

function decodeSamples(
  view: DataView,
  dataPtr: number,
  sampleCount: number,
  typeCode: number,
  fileSize: number,
  stride: number = 1,
): Float64Array {
  const byteSize = byteSizeForType(typeCode);
  const stepBytes = byteSize * stride;
  const maxSamples = Math.min(sampleCount, Math.floor((fileSize - dataPtr) / stepBytes));
  if (maxSamples <= 0) return new Float64Array(0);
  const samples = new Float64Array(maxSamples);

  for (let i = 0; i < maxSamples; i++) {
    const off = dataPtr + i * stepBytes;
    switch (typeCode) {
      case 1:
        samples[i] = view.getUint8(off);
        break;
      case 3:
        samples[i] = view.getUint16(off, true);
        break;
      case 4:
        samples[i] = view.getInt32(off, true);
        break;
      case 5:
        samples[i] = view.getUint32(off, true);
        break;
      case 6:
        samples[i] = view.getFloat32(off, true);
        break;
      case 7:
        samples[i] = view.getFloat64(off, true);
        break;
      default:
        samples[i] = view.getFloat32(off, true);
        break;
    }
  }

  return samples;
}

// ── Lap detection ─────────────────────────────────────────────────────

const LAP_BEACON_NAMES = ['lap_beacon', 'lap_beacon_trig', 'laptrigger'];
const LAP_TIME_NAMES = ['lap time', 'lap_time', 'laptime'];
const LAP_NUMBER_NAMES = ['lap number', 'lap_number', 'lapnumber'];
const LAP_DISTANCE_NAMES = ['lap distance corrected', 'lap_distance_corrected', 'lapdistancecorrected', 'lap distance', 'lap_distance', 'lapdistance'];

function nameMatches(channelName: string, candidates: string[]): boolean {
  const lower = channelName.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const noSpaces = lower.replace(/\s+/g, '');
  for (const c of candidates) {
    if (lower === c || noSpaces === c.replace(/\s+/g, '')) return true;
  }
  return false;
}

interface BuiltChannel {
  name: string;
  unit: string;
  frequency: number;
  samples: Float64Array;
}

function detectLapBoundaries(channels: BuiltChannel[]): LapBoundary[] {
  // 1. Lap beacon (rising edge)
  for (const ch of channels) {
    if (nameMatches(ch.name, LAP_BEACON_NAMES)) {
      const splits = risingEdgeSplits(ch.samples, ch.frequency);
      if (splits.length > 0) return deduplicateSplits(splits);
    }
  }

  // 2. Lap time (timer reset)
  for (const ch of channels) {
    if (nameMatches(ch.name, LAP_TIME_NAMES)) {
      const splits = timerResetSplits(ch.samples, ch.frequency);
      if (splits.length > 0) return deduplicateSplits(splits);
    }
  }

  // 3. Lap number (value change)
  for (const ch of channels) {
    if (nameMatches(ch.name, LAP_NUMBER_NAMES)) {
      const splits = valueChangeSplits(ch.samples, ch.frequency);
      if (splits.length > 0) return deduplicateSplits(splits);
    }
  }

  // 4. Lap distance (drop > 300m)
  for (const ch of channels) {
    if (nameMatches(ch.name, LAP_DISTANCE_NAMES)) {
      const splits = distanceDropSplits(ch.samples, ch.frequency);
      if (splits.length > 0) return deduplicateSplits(splits);
    }
  }

  return [];
}

function risingEdgeSplits(samples: Float64Array, freq: number): LapBoundary[] {
  const boundaries: LapBoundary[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]! !== 0 && samples[i - 1]! === 0) {
      boundaries.push({ timeSeconds: i / freq });
    }
  }
  return boundaries;
}

function timerResetSplits(samples: Float64Array, freq: number): LapBoundary[] {
  const boundaries: LapBoundary[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1]! - samples[i]! > 5.0) {
      boundaries.push({ timeSeconds: i / freq });
    }
  }
  return boundaries;
}

function valueChangeSplits(samples: Float64Array, freq: number): LapBoundary[] {
  const boundaries: LapBoundary[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] !== samples[i - 1]) {
      boundaries.push({ timeSeconds: i / freq });
    }
  }
  return boundaries;
}

function distanceDropSplits(samples: Float64Array, freq: number): LapBoundary[] {
  const boundaries: LapBoundary[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1]! - samples[i]! > 300) {
      boundaries.push({ timeSeconds: i / freq });
    }
  }
  return boundaries;
}

function deduplicateSplits(boundaries: LapBoundary[]): LapBoundary[] {
  if (boundaries.length === 0) return boundaries;
  boundaries.sort((a, b) => a.timeSeconds - b.timeSeconds);
  const result: LapBoundary[] = [boundaries[0]!];
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i]!.timeSeconds - result[result.length - 1]!.timeSeconds > 10) {
      result.push(boundaries[i]!);
    }
  }
  return result;
}

// ── Filename metadata ─────────────────────────────────────────────────

interface FilenameMeta {
  date: Date;
  driver: string;
  track: string;
  vehicle: string;
}

const TRACK_CODES: Record<string, string> = {
  SEB: 'Sebring',
  DAY: 'Daytona',
  IMS: 'Indianapolis',
  LGA: 'Laguna Seca',
  WAT: 'Watkins Glen',
  ELK: 'Elkhart Lake',
  MOS: 'Mosport',
  LIM: 'Lime Rock',
  PET: 'Petit Le Mans',
  COA: 'COTA',
  MID: 'Mid-Ohio',
  VIR: 'VIR',
  CAN: 'Canadian Tire Motorsport Park',
  LON: 'Long Beach',
  DET: 'Detroit',
};

function parseFilename(fileURL: string): FilenameMeta {
  const filename = fileURL.split('/').pop() ?? fileURL;
  const base = filename.replace(/\.pds$/i, '');

  const dateMatch = base.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  let date = new Date();
  if (dateMatch) {
    const [, yy, mm, dd, hh, mi, ss] = dateMatch;
    const year = 2000 + parseInt(yy!, 10);
    date = new Date(year, parseInt(mm!, 10) - 1, parseInt(dd!, 10), parseInt(hh!, 10), parseInt(mi!, 10), parseInt(ss!, 10));
  }

  const tokens = base.split('_');
  let track = 'Unknown';
  let driver = 'Unknown';
  let vehicle = 'Unknown';

  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (TRACK_CODES[upper]) {
      track = TRACK_CODES[upper]!;
    }
  }

  const runIdx = tokens.findIndex((t) => /^Run\d+$/i.test(t));
  if (runIdx >= 0 && runIdx + 1 < tokens.length) {
    driver = tokens[runIdx + 1] ?? 'Unknown';
    if (runIdx + 2 < tokens.length) {
      vehicle = tokens.slice(runIdx + 2).join(' ');
    }
  }

  if (base.startsWith('Export_')) {
    const exportTokens = base.replace(/^Export_/, '').split('_');
    if (exportTokens.length >= 1) {
      driver = exportTokens[0] ?? 'Unknown';
    }
    if (exportTokens.length >= 2) {
      vehicle = exportTokens.slice(1).join(' ');
    }
  }

  return { date, driver, track, vehicle };
}

// ── Main parser ───────────────────────────────────────────────────────

export function parsePds(data: Uint8Array, fileURL: string): Session {
  const fileSize = data.byteLength;
  if (fileSize < 0x100) {
    throw new ParseError('File too small to be a valid PDS file', 'pds');
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const warnings: SessionWarning[] = [];

  // 1. Parse directory
  const entries = findDirectory(view, fileSize);
  if (entries.length < 3) {
    throw new ParseError('PDS directory has fewer than 3 entries', 'pds');
  }

  // 2. Find layout
  const layout = findLayout(entries, fileSize);

  // 3. Find channel definitions
  const channelDefs = findChannelDefs(view, layout);

  // Detect export variant: markerless defs with small count + no 0x7c72 markers
  const hasMarkers = tryMarkerDefs(view, layout.defsOffset, layout.chunkOffset).length > 0;
  const isSmallDefCount = layout.defsCount > 0 && layout.defsCount <= 200;
  const isExportVariant = !hasMarkers && isSmallDefCount;

  // 4. Build raw channels
  const rawChannels: RawChannel[] = [];
  const builtChannels: BuiltChannel[] = [];

  if (isExportVariant) {
    // Export variant: data is float64, chunks are grouped by short-chunk boundaries,
    // channel defs sorted by sequence number map to groups in order.
    const chunks = parseChunks(view, layout, fileSize);

    // Group chunks by short-chunk boundaries (count < 100 = group start)
    const groups: ChunkRecord[][] = [];
    let currentGroup: ChunkRecord[] = [];
    for (const chunk of chunks) {
      if (chunk.sampleCount < 100 && currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [chunk];
      } else {
        currentGroup.push(chunk);
      }
    }
    if (currentGroup.length > 0) groups.push(currentGroup);

    // Sort channel defs by sequence number (= id field from parseMarkerlessDefs)
    // The defs were stored with id = array index, but we need the original seq number.
    // Re-read the seq numbers from the file.
    const defsWithSeq: { seq: number; name: string; defIdx: number }[] = [];
    const defsSpan = layout.chunkOffset - layout.defsOffset;
    const defRecSize = layout.defsCount > 0 ? Math.floor(defsSpan / layout.defsCount) : 304;
    for (let i = 0; i < layout.defsCount; i++) {
      const pos = layout.defsOffset + i * defRecSize;
      if (pos + 16 > fileSize) break;
      const seq = view.getUint32(pos, true);
      const name = readUtf16le(view, pos + 8, 112);
      if (name.length > 0) defsWithSeq.push({ seq, name, defIdx: i });
    }
    defsWithSeq.sort((a, b) => a.seq - b.seq);

    // Compute sample period from first valid chunk
    let samplePeriodTicks = 200000; // default 50Hz
    for (const chunk of chunks) {
      if (chunk.samplePeriodTicks > 0) { samplePeriodTicks = chunk.samplePeriodTicks; break; }
    }
    const frequency = Math.round(TICKS_PER_SECOND / samplePeriodTicks);

    // Read each group as float64 and assign to the seq-sorted channel def
    for (let g = 0; g < Math.min(groups.length, defsWithSeq.length); g++) {
      const def = defsWithSeq[g]!;
      const group = groups[g]!;
      const parts: Float64Array[] = [];
      let totalSamples = 0;

      for (const chunk of group) {
        const n = chunk.sampleCount;
        const maxN = Math.min(n, Math.floor((fileSize - chunk.dataPtr) / 8));
        if (maxN <= 0) continue;
        const decoded = new Float64Array(maxN);
        for (let i = 0; i < maxN; i++) {
          decoded[i] = view.getFloat64(chunk.dataPtr + i * 8, true);
        }
        parts.push(decoded);
        totalSamples += decoded.length;
      }

      if (totalSamples === 0) continue;
      const samples = new Float64Array(totalSamples);
      let offset = 0;
      for (const part of parts) { samples.set(part, offset); offset += part.length; }

      builtChannels.push({ name: def.name, unit: '', frequency, samples });
      rawChannels.push({ name: def.name, unit: '', frequency, samples });
    }
  } else {
    // Standard variant: chunks have channel_id, float32 data
    const defMap = new Map<number, ChannelDef>();
    for (const def of channelDefs) defMap.set(def.id, def);

    const chunks = parseChunks(view, layout, fileSize);
    // Standard variant: chunks have channel_id, group and concatenate
    const chunksByChannel = new Map<number, ChunkRecord[]>();
    for (const chunk of chunks) {
      let arr = chunksByChannel.get(chunk.channelId);
      if (!arr) { arr = []; chunksByChannel.set(chunk.channelId, arr); }
      arr.push(chunk);
    }
    for (const arr of chunksByChannel.values()) {
      arr.sort((a, b) => a.order - b.order || a.dataPtr - b.dataPtr);
    }

    for (const [channelId, channelChunks] of chunksByChannel) {
      const def = defMap.get(channelId);
      if (!def) continue;

      const parts: Float64Array[] = [];
      let totalSamples = 0;
      for (const chunk of channelChunks) {
        const decoded = decodeSamples(view, chunk.dataPtr, chunk.sampleCount, def.typeCode, fileSize);
        parts.push(decoded);
        totalSamples += decoded.length;
      }

      if (totalSamples === 0) continue;

      const samples = new Float64Array(totalSamples);
      let offset = 0;
      for (const part of parts) {
        samples.set(part, offset);
        offset += part.length;
      }

      const firstChunk = channelChunks[0]!;
      const frequency = Math.round(TICKS_PER_SECOND / firstChunk.samplePeriodTicks);

      const channel: BuiltChannel = { name: def.name, unit: def.unit, frequency, samples };
      builtChannels.push(channel);
      rawChannels.push({ name: def.name, unit: def.unit, frequency, samples });
    }
  }

  if (rawChannels.length === 0) {
    throw new ParseError('No channels decoded from PDS file', 'pds');
  }

  // 7. Detect lap boundaries
  const lapBoundaries = detectLapBoundaries(builtChannels);
  if (lapBoundaries.length === 0) {
    warnings.push({ code: 'no-lap-boundaries', message: 'No lap boundaries detected from telemetry channels' });
  }

  // 8. Extract metadata from filename
  const meta = parseFilename(fileURL);

  // 9. Build SessionData
  const sessionData: SessionData = {
    format: 'pds',
    driver: meta.driver,
    vehicle: meta.vehicle,
    track: meta.track,
    date: meta.date,
    rawChannels,
    lapBoundaries,
    circuit: null,
    warnings,
    fileURL,
  };

  return new Session(sessionData);
}
