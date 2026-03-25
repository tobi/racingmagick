import { readFile } from 'fs/promises';
import { Session } from '../session';
import { ParseError } from '../types';
import type { RawChannel, LapBoundary, SessionWarning, SessionData } from '../types';
import { MOTEC_MAGIC, MOTEC_CHANNEL_META_SIZE, MOTEC_MIN_FILE_SIZE, MAX_CHANNELS_PER_FILE } from '../constants';

const latin1 = new TextDecoder('latin1');

function readString(view: DataView, offset: number, length: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  return latin1.decode(bytes).replace(/\0.*$/, '').trim();
}

/**
 * Read a unit string that may contain a short_name prefix separated by null bytes.
 * iRacing LD files store "speed\0\0\0m/s\0" in the unit field.
 * We want the LAST null-separated segment that looks like a unit.
 */
function readUnitString(view: DataView, offset: number, length: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  const str = latin1.decode(bytes);
  // Split on null bytes, take non-empty segments
  const segments = str.split('\0').filter(s => s.trim().length > 0);
  if (segments.length === 0) return '';
  // If there's a segment that looks like a unit (contains / or is short), prefer it
  const unitLike = segments.find(s => s.includes('/') || s.length <= 4);
  return (unitLike ?? segments[segments.length - 1]!).trim();
}

interface ChannelMeta {
  nextAddr: number;
  dataPtr: number;
  nData: number;
  datatypeA: number;
  datatype: number;
  recFreq: number;
  shift: number;
  mul: number;
  scale: number;
  decPlaces: number;
  name: string;
  unit: string;
}

function parseChannelMeta(view: DataView, offset: number): ChannelMeta {
  return {
    nextAddr: view.getUint32(offset + 0x04, true),
    dataPtr: view.getUint32(offset + 0x08, true),
    nData: view.getUint32(offset + 0x0C, true),
    datatypeA: view.getUint16(offset + 0x12, true),
    datatype: view.getUint16(offset + 0x14, true),
    recFreq: view.getUint16(offset + 0x16, true),
    shift: view.getInt16(offset + 0x18, true),
    mul: view.getInt16(offset + 0x1A, true),
    scale: view.getInt16(offset + 0x1C, true),
    decPlaces: view.getInt16(offset + 0x1E, true),
    name: readString(view, offset + 0x20, 32),
    unit: readUnitString(view, offset + 0x40, 12),
  };
}

function readChannelData(
  view: DataView,
  meta: ChannelMeta,
  fileSize: number,
): Float64Array {
  if (meta.nData === 0) return new Float64Array(0);
  if (meta.dataPtr >= fileSize) return new Float64Array(0);

  const bytesPerSample = meta.datatype;
  if (bytesPerSample <= 0 || bytesPerSample > 8) return new Float64Array(0);
  const requiredBytes = meta.dataPtr + meta.nData * bytesPerSample;
  const clampedCount = requiredBytes > fileSize
    ? Math.floor((fileSize - meta.dataPtr) / bytesPerSample)
    : meta.nData;

  if (clampedCount <= 0) return new Float64Array(0);

  const samples = new Float64Array(clampedCount);
  const isFloat = meta.datatypeA === 0x07;

  if (isFloat) {
    if (bytesPerSample === 4) {
      for (let i = 0; i < clampedCount; i++) {
        samples[i] = view.getFloat32(meta.dataPtr + i * 4, true);
      }
    }
    // float16 is rare — fill with zeros
    return samples;
  }

  // Integer data — apply conversion formula
  const scaleEff = meta.scale === 0 ? 1 : meta.scale;
  const mulEff = meta.mul === 0 ? 1 : meta.mul;
  const decFactor = Math.pow(10, -meta.decPlaces);

  if (bytesPerSample === 2) {
    for (let i = 0; i < clampedCount; i++) {
      const raw = view.getInt16(meta.dataPtr + i * 2, true);
      samples[i] = (raw / scaleEff * decFactor + meta.shift) * mulEff;
    }
  } else if (bytesPerSample === 4) {
    for (let i = 0; i < clampedCount; i++) {
      const raw = view.getInt32(meta.dataPtr + i * 4, true);
      samples[i] = (raw / scaleEff * decFactor + meta.shift) * mulEff;
    }
  }

  return samples;
}

function parseDate(dateStr: string, timeStr: string, warnings: SessionWarning[]): Date {
  // Date format: "dd/MM/yyyy", Time format: "HH:mm:ss"
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    const [day, month, year] = parts;
    const parsed = new Date(`${year}-${month}-${day}T${timeStr || '00:00:00'}`);
    if (!isNaN(parsed.getTime())) return parsed;
  }
  warnings.push({
    code: 'suspicious-data-range',
    message: `Could not parse session date "${dateStr}" / "${timeStr}"; using current time`,
  });
  return new Date();
}

async function parseLdx(ldxPath: string): Promise<{ beacons: number[]; warning: string | null }> {
  try {
    const xml = await readFile(ldxPath, 'utf-8');
    const beacons: number[] = [];
    const pattern = /<Marker[^>]*\bTime="([^"]+)"/g;
    let match;
    while ((match = pattern.exec(xml)) !== null) {
      const time = parseFloat(match[1]!);
      if (!isNaN(time) && time >= 0) {
        beacons.push(time / 1_000_000); // microseconds to seconds
      }
    }
    beacons.sort((a, b) => a - b);
    return { beacons, warning: null };
  } catch {
    return { beacons: [], warning: `Companion .ldx file not found: ${ldxPath}` };
  }
}

export async function parseMotec(data: Uint8Array, fileURL: string): Promise<Session> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const fileSize = data.byteLength;

  // Validate magic
  if (fileSize < MOTEC_MIN_FILE_SIZE) {
    throw new ParseError('File too small to be a valid MoTeC .ld file', 'motec', { fileURL });
  }
  const magic = view.getUint32(0, true);
  if (magic !== MOTEC_MAGIC) {
    throw new ParseError(
      `Invalid MoTeC magic: expected 0x${MOTEC_MAGIC.toString(16)}, got 0x${magic.toString(16)}`,
      'motec',
      { fileURL },
    );
  }

  // Parse header
  const channelMetaPtr = view.getUint32(0x08, true);
  const dateStr = readString(view, 0x5E, 16);
  const timeStr = readString(view, 0x7E, 16);
  const driver = readString(view, 0x9E, 64);
  const vehicle = readString(view, 0xDE, 64);
  const venue = readString(view, 0x15E, 64);
  // Read channel data (warnings declared early for date parsing)
  const warnings: SessionWarning[] = [];
  const date = parseDate(dateStr, timeStr, warnings);

  // Walk channel linked list
  const channelMetas: ChannelMeta[] = [];
  let addr = channelMetaPtr;
  while (addr > 0 && addr + MOTEC_CHANNEL_META_SIZE <= fileSize && channelMetas.length < MAX_CHANNELS_PER_FILE) {
    const meta = parseChannelMeta(view, addr);
    channelMetas.push(meta);
    if (meta.nextAddr === 0 || meta.nextAddr <= addr) break;
    addr = meta.nextAddr;
  }

  if (channelMetas.length === 0) {
    throw new ParseError('No channels found in MoTeC file', 'motec', { fileURL });
  }
  const rawChannels: RawChannel[] = [];

  for (const meta of channelMetas) {
    const samples = readChannelData(view, meta, fileSize);
    if (samples.length === 0) {
      warnings.push({
        code: 'missing-optional-channel',
        message: `Channel "${meta.name}" has 0 samples`,
        channel: meta.name,
      });
      continue;
    }
    rawChannels.push({
      name: meta.name,
      unit: meta.unit,
      frequency: meta.recFreq,
      samples,
    });
  }

  if (rawChannels.length === 0) {
    throw new ParseError('All channels in MoTeC file have 0 samples', 'motec', { fileURL });
  }

  // Parse companion .ldx for lap beacons
  const ldxPath = fileURL.replace(/\.ld$/i, '.ldx');
  const { beacons, warning: ldxWarning } = await parseLdx(ldxPath);
  if (ldxWarning) {
    warnings.push({ code: 'no-lap-boundaries', message: ldxWarning });
  }

  // Build lap boundaries from beacons
  const lapBoundaries: LapBoundary[] = beacons.map((t) => ({ timeSeconds: t }));

  const sessionData: SessionData = {
    format: 'motec',
    driver,
    vehicle,
    track: venue,
    date,
    rawChannels,
    lapBoundaries,
    circuit: null,
    warnings,
    fileURL,
  };

  return new Session(sessionData);
}
