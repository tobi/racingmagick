import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';
import { parsePds } from '../parsers/pds';

const FIXTURES_DIR = resolve(__dirname, '../../fixtures/pds');

const fixtureExists = (name: string) => existsSync(resolve(FIXTURES_DIR, name));

const FIXTURE_FILES = [
  '260223171205_26IMSA02_T02_SEB_CT1_Run004_TL_MQ12Di_LMP2 #443.pds',
].filter(fixtureExists);

const NATIVE_RECORDING_FILES = [
  '250212084750_25IMSAT02_SEB_CT1_Run001_HM_Car11_#477.pds',
].filter(fixtureExists);

const UNSUPPORTED_EXPORT_FILES = [
  'Export_MB_CT5_SebringTest2026.pds',
  'Export_Tobi_QualySim_SebringTest2026.pds',
].filter(fixtureExists);

async function loadFixture(name: string): Promise<{ data: Uint8Array; path: string }> {
  const path = resolve(FIXTURES_DIR, name);
  const buf = await readFile(path);
  return { data: new Uint8Array(buf), path };
}

function writeUtf16le(view: DataView, offset: number, value: string, maxBytes: number): void {
  for (let i = 0; i < value.length && i * 2 + 1 < maxBytes; i++) {
    view.setUint16(offset + i * 2, value.charCodeAt(i), true);
  }
}

function writeDirectoryEntry(
  view: DataView,
  offset: number,
  entry: { sectionOffset: number; count: number; classA: number; classB: number; nextCount: number },
): void {
  view.setUint32(offset, entry.sectionOffset, true);
  view.setUint32(offset + 4, 0, true);
  view.setUint32(offset + 8, entry.count, true);
  view.setUint32(offset + 0x10, entry.classA, true);
  view.setUint32(offset + 0x14, entry.classB, true);
  view.setUint32(offset + 0x18, entry.nextCount, true);
}

function writeMarkerlessChannelDef(
  view: DataView,
  offset: number,
  entry: { id: number; name: string; unit?: string },
): void {
  view.setUint32(offset, entry.id, true);
  writeUtf16le(view, offset + 8, entry.name, 112);
  if (entry.unit) writeUtf16le(view, offset + 0x98, entry.unit, 32);
}

function writeChunk(
  view: DataView,
  offset: number,
  entry: { order: number; channelId: number; samplePeriodTicks: number; sampleCount: number; dataPtr: number },
): void {
  view.setUint32(offset, entry.order, true);
  view.setUint32(offset + 4, entry.channelId, true);
  view.setUint32(offset + 8, entry.channelId, true);
  view.setUint32(offset + 0x18, entry.samplePeriodTicks, true);
  view.setUint32(offset + 0x1c, entry.sampleCount, true);
  view.setUint32(offset + 0x38, entry.dataPtr, true);
}

function writeFloat64Samples(view: DataView, offset: number, samples: number[]): void {
  samples.forEach((sample, index) => view.setFloat64(offset + index * 8, sample, true));
}

function writeInt16Samples(view: DataView, offset: number, samples: number[]): void {
  samples.forEach((sample, index) => view.setInt16(offset + index * 2, sample, true));
}

function writeFloat32Samples(view: DataView, offset: number, samples: number[]): void {
  samples.forEach((sample, index) => view.setFloat32(offset + index * 4, sample, true));
}

function writeMarkerlessChannelDefWithType(
  view: DataView,
  offset: number,
  entry: { id: number; name: string; typeCode: number; unit?: string },
): void {
  view.setUint32(offset, entry.id, true);
  writeUtf16le(view, offset + 8, entry.name, 112);
  if (entry.unit) writeUtf16le(view, offset + 0x98, entry.unit, 32);
  view.setUint32(offset + 0xd0, entry.typeCode, true);
}

function buildPdsWithVariableDefinitionClass(): Uint8Array {
  const data = new Uint8Array(0x500);
  const view = new DataView(data.buffer);
  const defsOffset = 0x200;
  const defRecordSize = 0xc0;
  const chunkOffset = defsOffset + defRecordSize * 2;
  const nextOffset = chunkOffset + 0x40 * 2;
  const speedDataPtr = 0x480;
  const throttleDataPtr = 0x4a0;

  writeDirectoryEntry(view, 0x80, {
    sectionOffset: defsOffset,
    count: 2,
    classA: 8,
    classB: 1,
    nextCount: 2,
  });
  writeDirectoryEntry(view, 0xa0, {
    sectionOffset: chunkOffset,
    count: 2,
    classA: 1,
    classB: 3,
    nextCount: 0,
  });
  writeDirectoryEntry(view, 0xc0, {
    sectionOffset: nextOffset,
    count: 0,
    classA: 1,
    classB: 1,
    nextCount: 0,
  });

  writeMarkerlessChannelDef(view, defsOffset, { id: 1, name: 'speed', unit: 'm/s' });
  writeMarkerlessChannelDef(view, defsOffset + defRecordSize, { id: 2, name: 'throttle pedal' });

  writeChunk(view, chunkOffset, {
    order: 0,
    channelId: 1,
    samplePeriodTicks: 1_000_000,
    sampleCount: 4,
    dataPtr: speedDataPtr,
  });
  writeChunk(view, chunkOffset + 0x40, {
    order: 1,
    channelId: 2,
    samplePeriodTicks: 1_000_000,
    sampleCount: 4,
    dataPtr: throttleDataPtr,
  });

  writeFloat64Samples(view, speedDataPtr, [10, 11, 12, 13]);
  writeFloat64Samples(view, throttleDataPtr, [0, 25, 50, 75]);

  return data;
}

interface TypedTestChannel {
  id: number;
  name: string;
  typeCode: number;
  samples: number[];
}

// Native (non-export) markerless layout: more than 200 channel definitions —
// so it is parsed as a recording rather than a compact export — each carrying a
// per-channel type code at +0xD0. One sample per second keeps the resample grid
// identical to the source samples, so decoded values pass through unchanged.
// Only the first few definition slots are populated; the remaining empty-name
// slots are skipped by the parser.
function buildMarkerlessPdsWithTypeCodes(channels: TypedTestChannel[]): Uint8Array {
  const defsOffset = 0x200;
  const defRecordSize = 0xe0; // >= 0xD4 so the +0xD0 type field fits in-record
  const defsCount = 201; // > 200 marks this as a native recording, not an export
  const chunkOffset = defsOffset + defRecordSize * defsCount;
  const chunkRecordSize = 0x40;
  const nextOffset = chunkOffset + chunkRecordSize * channels.length;
  const dataBase = nextOffset;
  const dataStride = 0x40;
  const fileSize = dataBase + dataStride * channels.length + 0x40;

  const data = new Uint8Array(fileSize);
  const view = new DataView(data.buffer);

  writeDirectoryEntry(view, 0x80, {
    sectionOffset: defsOffset,
    count: defsCount,
    classA: 8,
    classB: 1,
    nextCount: channels.length,
  });
  writeDirectoryEntry(view, 0xa0, {
    sectionOffset: chunkOffset,
    count: channels.length,
    classA: 1,
    classB: 3,
    nextCount: 0,
  });
  writeDirectoryEntry(view, 0xc0, {
    sectionOffset: nextOffset,
    count: 0,
    classA: 1,
    classB: 1,
    nextCount: 0,
  });

  channels.forEach((ch, index) => {
    writeMarkerlessChannelDefWithType(view, defsOffset + index * defRecordSize, {
      id: ch.id,
      name: ch.name,
      typeCode: ch.typeCode,
    });

    const dataPtr = dataBase + index * dataStride;
    writeChunk(view, chunkOffset + index * chunkRecordSize, {
      order: index,
      channelId: ch.id,
      samplePeriodTicks: 10_000_000, // 1 Hz: source grid == resample grid
      sampleCount: ch.samples.length,
      dataPtr,
    });

    switch (ch.typeCode) {
      case 2: writeInt16Samples(view, dataPtr, ch.samples); break;
      case 6: writeFloat32Samples(view, dataPtr, ch.samples); break;
      default: throw new Error(`unhandled test type code ${ch.typeCode}`);
    }
  });

  return data;
}

describe('PDS parser', () => {
  it('detects markerless layouts when the definition section class varies', () => {
    const data = buildPdsWithVariableDefinitionClass();
    const session = parsePds(data, '260101120000_26IMSA01_T01_SEB_CT1_Run001_QA_Car01.pds');

    expect(session.format).toBe('pds');
    expect(session.matrix.has('speed')).toBe(true);
    expect(session.matrix.has('throttle')).toBe(true);
    expect(session.sampleRate).toBe(10);
  });

  it('decodes native markerless channels using the per-channel type code at +0xD0', () => {
    const data = buildMarkerlessPdsWithTypeCodes([
      // speed + throttle are required for the parser to validate the session
      { id: 1, name: 'speed', typeCode: 6, samples: [10, 20, 30, 40] },
      { id: 2, name: 'throttle pedal', typeCode: 6, samples: [0, 25, 50, 75] },
      // f32: the old code hardcoded float64 and over-read eight bytes per sample
      { id: 3, name: 'decode_f32_test', typeCode: 6, samples: [1.5, -2.25, 100.5, 3.25] },
      // i16: a newly handled type code; the negative value also pins signedness
      { id: 4, name: 'decode_i16_test', typeCode: 2, samples: [-30000, -1, 1, 30000] },
    ]);
    const session = parsePds(data, '260101120000_26IMSA01_T01_SEB_CT1_Run001_QA_Car01.pds');

    expect(session.format).toBe('pds');
    expect(session.sampleRate).toBe(1);

    const f32 = session.matrix.row('decode_f32_test');
    const i16 = session.matrix.row('decode_i16_test');
    expect(f32).not.toBeNull();
    expect(i16).not.toBeNull();

    expect(Array.from(f32!)).toEqual([1.5, -2.25, 100.5, 3.25]);
    expect(Array.from(i16!)).toEqual([-30000, -1, 1, 30000]);
  });

  for (const file of FIXTURE_FILES) {
    describe(file, () => {
      it('parses without throwing', async () => {
        const { data, path } = await loadFixture(file);
        const session = parsePds(data, path);
        expect(session).toBeDefined();
      });

      it('has channels including speed', async () => {
        const { data, path } = await loadFixture(file);
        const session = parsePds(data, path);
        expect(session.matrix.channels.length).toBeGreaterThan(0);
        // Speed channel should be present (required by Session constructor)
        const speedRow = session.matrix.row('speed');
        expect(speedRow).toBeDefined();
      });

      it('has speed values in reasonable range (0-400 km/h)', async () => {
        const { data, path } = await loadFixture(file);
        const session = parsePds(data, path);
        const speedRow = session.matrix.row('speed')!;
        let maxSpeed = 0;
        for (let i = 0; i < speedRow.length; i++) {
          if (speedRow[i]! > maxSpeed) maxSpeed = speedRow[i]!;
        }
        expect(maxSpeed).toBeGreaterThan(0);
        expect(maxSpeed).toBeLessThan(400);
      });

      it('has at least 1 lap', async () => {
        const { data, path } = await loadFixture(file);
        const session = parsePds(data, path);
        expect(session.lapCount).toBeGreaterThanOrEqual(1);
      });

      it('format is pds', async () => {
        const { data, path } = await loadFixture(file);
        const session = parsePds(data, path);
        expect(session.format).toBe('pds');
      });

      it('sampleRate > 0', async () => {
        const { data, path } = await loadFixture(file);
        const session = parsePds(data, path);
        expect(session.sampleRate).toBeGreaterThan(0);
      });
    });
  }

  describe.skipIf(FIXTURE_FILES.length === 0)('directory parsing', () => {
    it('reads directory entries from files with standard offset', async () => {
      const { data } = await loadFixture(FIXTURE_FILES[0]!);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      // File 2 has entry count at 0x88
      const entryCount = view.getUint32(0x88, true);
      expect(entryCount).toBeGreaterThan(2);
      expect(entryCount).toBeLessThanOrEqual(64);
    });

    it.skipIf(NATIVE_RECORDING_FILES.length === 0)('detects native recording format and throws clear error', async () => {
      const { data, path } = await loadFixture(NATIVE_RECORDING_FILES[0]!);
      expect(() => parsePds(data, path)).toThrow('native recording format');
    });
  });

  describe.skipIf(FIXTURE_FILES.length === 0)('channel definition discovery', () => {
    it('finds marker 0x7c72 in file with marker-based defs', async () => {
      // File 2 uses 0x7c72 markers
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      expect(session.matrix.channels.length).toBeGreaterThan(5);
    });

    it('parses markerless channel definitions in legacy file', async () => {
      // File 1 also uses markerless definitions
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      expect(session.matrix.channels.length).toBeGreaterThan(5);
    });
  });

  describe.skipIf(FIXTURE_FILES.length === 0)('both layout variants work', () => {
    it('parses legacy variant (large file)', async () => {
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      expect(session.matrix.channels.length).toBeGreaterThan(5);
    });

    it.skipIf(UNSUPPORTED_EXPORT_FILES.length === 0)('compact export variant parses successfully', async () => {
      const { data, path } = await loadFixture(UNSUPPORTED_EXPORT_FILES[0]!);
      const session = parsePds(data, path);
      expect(session.matrix.channels.length).toBeGreaterThan(5);
    });
  });

  describe.skipIf(FIXTURE_FILES.length === 0)('multi-chunk channel assembly', () => {
    it('assembles multi-chunk channels correctly in legacy file', async () => {
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      const speedRow = session.matrix.row('speed')!;
      // Should have substantial number of samples for a 72MB file
      expect(speedRow.length).toBeGreaterThan(1000);
    });
  });

  describe.skipIf(FIXTURE_FILES.length === 0)('UTF-16LE string decoding', () => {
    it('decodes channel names correctly', async () => {
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      // Speed channel should exist, which means name was decoded properly
      const hasSpeed = session.matrix.has('speed');
      expect(hasSpeed).toBe(true);
    });
  });

  describe.skipIf(FIXTURE_FILES.length === 0)('filename metadata extraction', () => {
    it('extracts driver from standard filename', async () => {
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      expect(session.driver).toBe('TL');
    });

    it('extracts track from standard filename', async () => {
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      expect(session.track).toBe('Sebring');
    });

    it('extracts date from standard filename', async () => {
      const { data, path } = await loadFixture(FIXTURE_FILES[0]!);
      const session = parsePds(data, path);
      expect(session.date.getFullYear()).toBe(2026);
      expect(session.date.getMonth() + 1).toBe(2);
      expect(session.date.getDate()).toBe(23);
    });
  });

  describe('compact export files', () => {
    if (UNSUPPORTED_EXPORT_FILES.length === 0) it.skip('no compact export fixtures present', () => {});

    for (const file of UNSUPPORTED_EXPORT_FILES) {
      it(`${file} parses as float64 export variant`, async () => {
        const { data, path } = await loadFixture(file);
        const session = parsePds(data, path);
        expect(session.format).toBe('pds');
        expect(session.lapCount).toBeGreaterThanOrEqual(1);
        expect(session.matrix.sampleCount).toBeGreaterThan(0);
      });
    }
  });
});
