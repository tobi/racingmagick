// Import classes first
import { VBOParser } from './parser';
import { LapDetection } from './lap-detection';
import type { VBOParserOptions } from './types';

// Main parser class
export { VBOParser } from './parser';

// Session comparison and synchronization
export { SessionComparison } from './session-comparison';
export type { 
  NormalizedPosition,
  SessionComparisonOptions,
  SessionState 
} from './session-comparison';

// Lap detection utilities
export { LapDetection } from './lap-detection';
export type { LapDetectionOptions } from './lap-detection';

// Core types and schemas
export {
  // Zod schemas
  VBOChannelSchema,
  VBOHeaderSchema,
  VBODataPointSchema,
  VBOSectorSchema,
  VBOLapSchema,
  VBOVideoFileSchema,
  VBOSessionSchema,
  
  // TypeScript types
  type VBOHeader,
  type VBOChannel,
  type VBODataPoint,
  type VBOLap,
  type VBOSector,
  type VBOSession,
  type VBOVideoFile,
  type TrackPoint,
  type VBOParserOptions,
  type FileSystemFileHandle,
  type FileSystemDirectoryHandle,
  
  // Error classes
  VBOParseError,
  VBOValidationError,
} from './types';

// Re-export zod for convenience
export { z } from 'zod';

// Version
export const VERSION = '1.0.0';

// Default parser instance for convenience
export const defaultParser = new VBOParser();

// Convenience functions
export const parseVBOFile = (input: File | string | Uint8Array, options?: VBOParserOptions) => {
  const parser = options ? new VBOParser(options) : defaultParser;
  return parser.parseVBOFile(input);
};

export const parseMultipleVBOFiles = (input: FileList | File[], options?: VBOParserOptions) => {
  const parser = options ? new VBOParser(options) : defaultParser;
  return parser.parseVBOFromInput(input);
};

// Utility exports
export const getVideoForDataPoint = VBOParser.getVideoForDataPoint;
export const calculateDistance = VBOParser.calculateDistance;
export const listVBOFiles = VBOParser.listVBOFiles;
export const openFilePicker = VBOParser.openFilePicker;

// Lap detection utilities
export const detectLaps = LapDetection.detectLaps;
export const findFastestLap = LapDetection.findFastestLap;
export const calculateAverageLapTime = LapDetection.calculateAverageLapTime;
export const findBestSectorTimes = LapDetection.findBestSectorTimes;

// Exporters
export { VBOExporter, exportToCSV, exportToMotecLD } from './exporters';
export type {
  ExportFormat,
  CSVExportOptions,
  MotecLDExportOptions,
} from './exporters';