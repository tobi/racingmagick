import { readFile } from 'fs/promises';
import { Session } from './session';
import { ParseError } from './types';
import type { SessionFormat } from './types';

// Re-export public API
export { Session } from './session';
export { Lap } from './lap';
export { LapSample, LapSampleSlice } from './lap-sample';
export { ChannelMatrix } from './channel-matrix';
export {
  ParseError, LapError, LapKind,
  type SessionFormat, type SessionWarning, type ChannelAvailability,
  type LapInfo, type LapDelta, type SectorTime, type CircuitInfo,
  type TimingLine, type Stint, type PositionSource, type WarningCode,
} from './types';
export type { VideoAttachment, VideoSync, VideoFile, VideoSyncMethod } from './video';
export { scoreFilenameMatch, discoverVideoFiles, fixVideoCommands } from './video';
export { extractVideoTelemetry, detectVideoLapCrossings, alignLapCrossings } from './video-extract';
export type { VideoTelemetry, VideoGpsSample, VideoMetadata } from './video-extract';
export { saveVbo, saveVboAndVideo } from './writers/vbo';

/**
 * Parse any supported telemetry file.
 * Format is auto-detected from extension, or can be specified explicitly.
 */
export async function parseFile(
  input: string | Uint8Array,
  format?: SessionFormat,
): Promise<Session> {
  if (typeof input === 'string') {
    // File path
    const ext = input.split('.').pop()?.toLowerCase();
    const detectedFormat = format ?? detectFormat(ext);
    const data = await readFile(input);
    return parseBuffer(new Uint8Array(data), detectedFormat, input);
  }

  if (!format) {
    throw new ParseError('Format must be specified when parsing from Uint8Array');
  }
  return parseBuffer(input, format, 'buffer');
}

export async function parseMoTeC(input: string | Uint8Array): Promise<Session> {
  const { parseMotec } = await import('./parsers/motec');
  if (typeof input === 'string') {
    const data = await readFile(input);
    return parseMotec(new Uint8Array(data), input);
  }
  return parseMotec(input, 'buffer.ld');
}

export async function parsePDS(input: string | Uint8Array): Promise<Session> {
  const { parsePds } = await import('./parsers/pds');
  if (typeof input === 'string') {
    const data = await readFile(input);
    return parsePds(new Uint8Array(data), input);
  }
  return parsePds(input, 'buffer.pds');
}

export async function parseVBO(input: string | Uint8Array): Promise<Session> {
  const { parseVbo } = await import('./parsers/vbo');
  if (typeof input === 'string') {
    const data = await readFile(input);
    return parseVbo(new Uint8Array(data), input);
  }
  return parseVbo(input, 'buffer.vbo');
}

function detectFormat(ext?: string): SessionFormat {
  switch (ext) {
    case 'ld': return 'motec';
    case 'pds': return 'pds';
    case 'vbo': return 'vbo';
    default: throw new ParseError(`Unknown file extension: .${ext}`);
  }
}

async function parseBuffer(
  data: Uint8Array,
  format: SessionFormat,
  fileURL: string,
): Promise<Session> {
  switch (format) {
    case 'motec': {
      const { parseMotec } = await import('./parsers/motec');
      return parseMotec(data, fileURL);
    }
    case 'pds': {
      const { parsePds } = await import('./parsers/pds');
      return parsePds(data, fileURL);
    }
    case 'vbo': {
      const { parseVbo } = await import('./parsers/vbo');
      return parseVbo(data, fileURL);
    }
    default:
      throw new ParseError(`Unsupported format: ${format}`);
  }
}
