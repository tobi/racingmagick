import { Session } from '../session';
import { ParseError } from '../types';
import type {
  SessionData, RawChannel, LapBoundary, SessionWarning,
  CircuitInfo, TimingLine,
} from '../types';

// ── Built-in VBOX channel names (always present in [header]) ─────────
// These are the standard channels that appear before custom CAN channels.
// The [column names] section maps them to shorter labels.
const BUILTIN_HEADER_CHANNELS = [
  'satellites', 'time', 'latitude', 'longitude',
  'velocity kmh', 'heading', 'height', 'vertical velocity m/s',
  'sampleperiod', 'solution type', 'avifileindex', 'avisynctime',
];

// ── Time parsing ─────────────────────────────────────────────────────

/** Parse HHMMSS.mmm → seconds since midnight */
export function vboTimeToSeconds(raw: number): number {
  const hours = Math.floor(raw / 10000);
  const minutes = Math.floor((raw % 10000) / 100);
  const seconds = raw % 100; // includes fractional part
  return hours * 3600 + minutes * 60 + seconds;
}

// ── Section parsing ──────────────────────────────────────────────────

interface VboSections {
  fileCreatedLine: string | null;
  header: string[];
  channelUnits: string[];
  columnNames: string[];
  dataLines: string[];
  laptiming: string[];
  circuitDetails: string[];
}

function parseSections(text: string): VboSections {
  const lines = text.split(/\r?\n/);
  const result: VboSections = {
    fileCreatedLine: null,
    header: [],
    channelUnits: [],
    columnNames: [],
    dataLines: [],
    laptiming: [],
    circuitDetails: [],
  };

  let currentSection: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect "File created on" line (before any section)
    if (trimmed.startsWith('File created on')) {
      result.fileCreatedLine = trimmed;
      continue;
    }

    // Section headers
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1).toLowerCase();
      continue;
    }

    if (trimmed === '') {
      // Empty lines don't end sections, just skip
      continue;
    }

    switch (currentSection) {
      case 'header':
        result.header.push(trimmed);
        break;
      case 'channel units':
        result.channelUnits.push(trimmed);
        break;
      case 'column names':
        // Single line with space-separated names
        result.columnNames = trimmed.split(/\s+/);
        currentSection = null; // only one line
        break;
      case 'data':
        result.dataLines.push(line); // preserve original whitespace for splitting
        break;
      case 'laptiming':
        result.laptiming.push(trimmed);
        break;
      case 'circuit details':
        result.circuitDetails.push(trimmed);
        break;
      // Other sections (comments, AVI, session data) — skip
    }
  }

  return result;
}

// ── Laptiming parsing ────────────────────────────────────────────────

function parseLaptiming(lines: string[]): TimingLine[] {
  const timingLines: TimingLine[] = [];

  for (const line of lines) {
    // Format: Start/Split   +lat1 +lon1 +lat2 +lon2 ¬ Name
    const match = line.match(
      /^(Start|Split)\s+([-+]?\d+\.\d+)\s+([-+]?\d+\.\d+)\s+([-+]?\d+\.\d+)\s+([-+]?\d+\.\d+)\s*¬\s*(.+)$/,
    );
    if (!match) continue;

    const type = match[1].toLowerCase() as 'start' | 'split';
    // Note: in VBO laptiming, coordinates are in VBOX minutes format
    // We store them as-is — the session constructor handles conversion
    const lat1 = parseFloat(match[2]);
    const lon1 = parseFloat(match[3]);
    const lat2 = parseFloat(match[4]);
    const lon2 = parseFloat(match[5]);
    const name = match[6].trim();

    timingLines.push({
      type,
      name,
      start: { lat: lat1, lon: lon1 },
      end: { lat: lat2, lon: lon2 },
    });
  }

  return timingLines;
}

// ── Circuit details parsing ──────────────────────────────────────────

function parseCircuitDetails(lines: string[]): { name: string | null; country: string | null } {
  let name: string | null = null;
  let country: string | null = null;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith('circuit ')) {
      name = line.slice('circuit '.length).trim();
    } else if (lower.startsWith('country ')) {
      country = line.slice('country '.length).trim();
    }
  }

  return { name, country };
}

// ── Date parsing ─────────────────────────────────────────────────────

function parseFileDate(line: string | null): Date {
  if (!line) return new Date(0);

  // "File created on DD/MM/YYYY @ HH:MM:SS"
  const match = line.match(/(\d{2})\/(\d{2})\/(\d{4})\s*@\s*(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return new Date(0);

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1; // 0-based
  const year = parseInt(match[3], 10);
  const hours = parseInt(match[4], 10);
  const minutes = parseInt(match[5], 10);
  const seconds = parseInt(match[6], 10);

  return new Date(year, month, day, hours, minutes, seconds);
}

// ── Build channel name mapping ───────────────────────────────────────

/**
 * Build the ordered list of channel names from [column names] or [header].
 *
 * The [column names] section gives the actual data column order using short
 * labels (e.g., "sats", "lat", "long"). The [header] section lists the
 * full channel names. Custom (CAN) channels appear after the built-in ones
 * in both sections.
 *
 * Strategy:
 * - If [column names] exists, use it directly — these map 1:1 to data columns.
 * - Otherwise, build from [header]: built-in channels come first (with their
 *   standard short names for data parsing), then custom channels.
 */
function buildChannelNames(
  header: string[],
  columnNames: string[],
): string[] {
  if (columnNames.length > 0) {
    return columnNames;
  }

  // Fall back to header — map built-in names to column short names
  const builtinShort = [
    'sats', 'time', 'lat', 'long', 'velocity', 'heading',
    'height', 'vert-vel', 'Tsample', 'solution_type',
    'avifileindex', 'avitime',
  ];

  const names: string[] = [];
  for (let i = 0; i < header.length; i++) {
    if (i < BUILTIN_HEADER_CHANNELS.length) {
      names.push(builtinShort[i]);
    } else {
      // Custom channels keep their header name
      names.push(header[i]);
    }
  }
  return names;
}

/**
 * Map column short names back to their full header names for channel resolution.
 * The [header] section contains the "real" channel names that the channel resolver
 * recognizes (e.g., "velocity kmh", "Throttle_Pedal").
 */
function buildColumnToHeaderMap(
  header: string[],
  columnNames: string[],
): Map<string, string> {
  const map = new Map<string, string>();

  // The header and column names are ordered identically.
  // Custom channels start at index BUILTIN_HEADER_CHANNELS.length in the header.
  // In column names, built-in columns come first, then custom ones.
  const builtinCount = BUILTIN_HEADER_CHANNELS.length;

  for (let i = 0; i < columnNames.length; i++) {
    if (i < header.length) {
      map.set(columnNames[i], header[i]);
    } else {
      map.set(columnNames[i], columnNames[i]);
    }
  }

  return map;
}

// ── Channel unit mapping ─────────────────────────────────────────────

/**
 * Channel units from [channel units] section.
 * Units correspond to the custom CAN channels only (not built-in VBOX channels).
 * Built-in channels have known units.
 */
function buildUnitMap(
  channelNames: string[],
  header: string[],
  channelUnits: string[],
): Map<string, string> {
  const unitMap = new Map<string, string>();
  const builtinCount = BUILTIN_HEADER_CHANNELS.length;

  // Built-in channel units
  const builtinUnits: Record<string, string> = {
    sats: '',
    time: 's',
    lat: 'min',   // VBOX minutes
    long: 'min',  // VBOX minutes
    velocity: 'km/h',
    heading: 'deg',
    height: 'm',
    'vert-vel': 'm/s',
    Tsample: 's',
    solution_type: '',
    avifileindex: '',
    avitime: '',
  };

  for (const [name, unit] of Object.entries(builtinUnits)) {
    unitMap.set(name, unit);
  }

  // Custom channel units — from [channel units] section
  // These map to the custom channels in header (after built-in ones)
  const customStart = builtinCount;
  for (let i = 0; i < channelUnits.length; i++) {
    const headerIdx = customStart + i;
    if (headerIdx < header.length) {
      // Find the matching column name
      const colName = channelNames[headerIdx];
      if (colName) {
        const unit = channelUnits[i] === '(null)' ? '' : channelUnits[i];
        unitMap.set(colName, unit);
      }
    }
  }

  return unitMap;
}

// ── Main parser ──────────────────────────────────────────────────────

export function parseVbo(data: Uint8Array, fileURL: string): Session {
  if (data.length === 0) {
    throw new ParseError('Empty VBO file', 'vbo');
  }

  // Decode as UTF-8, fall back to Latin-1
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    text = new TextDecoder('latin1').decode(data);
  }

  const sections = parseSections(text);

  if (sections.dataLines.length === 0) {
    throw new ParseError('No [data] section found in VBO file', 'vbo');
  }

  const warnings: SessionWarning[] = [];

  // Build channel names
  const channelNames = buildChannelNames(sections.header, sections.columnNames);
  const colToHeader = buildColumnToHeaderMap(sections.header, channelNames);
  const unitMap = buildUnitMap(channelNames, sections.header, sections.channelUnits);

  // Parse data rows
  const numColumns = channelNames.length;
  const numRows = sections.dataLines.length;

  // Pre-allocate column arrays
  const columns: Float64Array[] = [];
  for (let c = 0; c < numColumns; c++) {
    columns.push(new Float64Array(numRows));
  }

  let validRows = 0;
  for (let r = 0; r < numRows; r++) {
    const tokens = sections.dataLines[r].trim().split(/\s+/);
    if (tokens.length < 2) continue; // skip malformed lines

    for (let c = 0; c < numColumns; c++) {
      if (c < tokens.length) {
        columns[c][validRows] = parseFloat(tokens[c]);
      }
    }
    validRows++;
  }

  // Trim to valid row count
  if (validRows < numRows) {
    for (let c = 0; c < numColumns; c++) {
      columns[c] = columns[c].slice(0, validRows);
    }
  }

  if (validRows === 0) {
    throw new ParseError('No data rows in VBO file', 'vbo');
  }

  // Identify column indices
  const colIndex = new Map<string, number>();
  for (let i = 0; i < channelNames.length; i++) {
    colIndex.set(channelNames[i].toLowerCase(), i);
  }

  const timeIdx = colIndex.get('time');
  const samplePeriodIdx = colIndex.get('tsample');

  // Parse time column (HHMMSS.mmm → session-relative seconds)
  if (timeIdx === undefined) {
    throw new ParseError('No time column in VBO file', 'vbo');
  }

  const timeCol = columns[timeIdx];
  const timeSeconds = new Float64Array(validRows);
  const firstTime = vboTimeToSeconds(timeCol[0]);
  for (let i = 0; i < validRows; i++) {
    let t = vboTimeToSeconds(timeCol[i]);
    // Handle midnight wraparound
    if (t < firstTime - 43200) {
      t += 86400;
    }
    timeSeconds[i] = t - firstTime;
  }

  // Determine sample rate
  let sampleRate: number;
  if (samplePeriodIdx !== undefined) {
    // Use first nonzero sampleperiod value
    let period = 0;
    for (let i = 0; i < validRows; i++) {
      if (columns[samplePeriodIdx][i] > 0) {
        period = columns[samplePeriodIdx][i];
        break;
      }
    }
    sampleRate = period > 0 ? 1 / period : 10;
  } else {
    // Derive from time deltas
    if (validRows > 1) {
      const dt = timeSeconds[1] - timeSeconds[0];
      sampleRate = dt > 0 ? Math.round(1 / dt) : 10;
    } else {
      sampleRate = 10;
    }
  }

  // Build RawChannel array
  const rawChannels: RawChannel[] = [];

  // Time channel (already converted)
  rawChannels.push({
    name: 'time',
    unit: 's',
    frequency: sampleRate,
    samples: timeSeconds,
  });

  // Video data and driver ID (captured during column processing)
  let vboAviFileIndex: Float64Array | undefined;
  let vboAviSyncTime: Float64Array | undefined;
  let vboDriverId: number | undefined;

  // Process each data column
  for (let c = 0; c < numColumns; c++) {
    const colName = channelNames[c];
    const colNameLower = colName.toLowerCase();

    // Skip time — already handled
    if (colNameLower === 'time') continue;

    // Skip internal VBOX columns we don't need as channels (but capture video data)
    if (['tsample', 'avifileindex', 'avitime', 'solution_type'].includes(colNameLower)) {
      if (colNameLower === 'solution_type') {
        rawChannels.push({
          name: 'solution type',
          unit: '',
          frequency: sampleRate,
          samples: columns[c],
        });
      }
      if (colNameLower === 'avifileindex') vboAviFileIndex = columns[c];
      if (colNameLower === 'avitime') vboAviSyncTime = columns[c];
      continue;
    }

    // Capture DriverID value for session metadata
    if (colNameLower === 'driverid' || colNameLower === 'driver_id') {
      const first = columns[c][0];
      if (first !== undefined && first !== 0) vboDriverId = first;
    }

    // Map column name to header name for resolution
    const headerName = colToHeader.get(colName) ?? colName;
    const unit = unitMap.get(colName) ?? '';

    // Use the header name for channel resolution
    rawChannels.push({
      name: headerName,
      unit,
      frequency: sampleRate,
      samples: columns[c],
    });
  }

  // If no explicit vehicle speed CAN channel exists, use VBOX velocity as speed
  const hasSpeedChannel = rawChannels.some((ch) => {
    const n = ch.name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    return n === 'speed' || n === 'vehicle speed' || n === 'vehiclespeed'
      || n === 'corr speed' || n === 'ground speed' || n === 'wheel speed avg';
  });
  if (!hasSpeedChannel) {
    const velIdx = colIndex.get('velocity');
    if (velIdx !== undefined) {
      rawChannels.push({
        name: 'speed',
        unit: 'km/h',
        frequency: sampleRate,
        samples: columns[velIdx],
      });
    }
  }

  // Detect lap boundaries from Lap_Number channel transitions
  const lapBoundaries: LapBoundary[] = [];
  const lapNumIdx = findColumnIndex(channelNames, ['lap_number', 'lapnumber']);

  if (lapNumIdx !== undefined) {
    const lapNums = columns[lapNumIdx];
    // Add boundary at start
    lapBoundaries.push({ timeSeconds: timeSeconds[0] });

    let prevLap = lapNums[0];
    for (let i = 1; i < validRows; i++) {
      if (lapNums[i] !== prevLap) {
        lapBoundaries.push({ timeSeconds: timeSeconds[i] });
        prevLap = lapNums[i];
      }
    }
  }

  // If no lap boundaries detected from data, create a single lap spanning the whole session
  if (lapBoundaries.length === 0) {
    lapBoundaries.push({ timeSeconds: timeSeconds[0] });
  }

  // Parse laptiming
  const timingLines = parseLaptiming(sections.laptiming);

  // Parse circuit details
  const circuitInfo = parseCircuitDetails(sections.circuitDetails);
  const circuit: CircuitInfo = {
    name: circuitInfo.name,
    country: circuitInfo.country,
    timingLines,
  };

  // Parse date — use file creation date + GPS UTC time from first sample
  const date = parseFileDate(sections.fileCreatedLine);
  // firstTime (seconds since midnight UTC from GPS) is more accurate than
  // the file creation timestamp which may be in local time
  const gpsHours = Math.floor(firstTime / 3600);
  const gpsMinutes = Math.floor((firstTime % 3600) / 60);
  const gpsSeconds = Math.floor(firstTime % 60);
  date.setUTCHours(gpsHours, gpsMinutes, gpsSeconds);

  // Build SessionData
  const sessionData: SessionData = {
    format: 'vbo',
    driver: '',
    vehicle: '',
    track: circuitInfo.name ?? '',
    date,
    rawChannels,
    lapBoundaries,
    circuit: circuit.name || circuit.country || timingLines.length > 0 ? circuit : null,
    warnings,
    fileURL,
    driverId: vboDriverId,
    vboAviFileIndex,
    vboAviSyncTime,
  };

  return new Session(sessionData);
}

// ── Helpers ──────────────────────────────────────────────────────────

function findColumnIndex(
  channelNames: string[],
  candidates: string[],
): number | undefined {
  for (let i = 0; i < channelNames.length; i++) {
    const lower = channelNames[i].toLowerCase();
    if (candidates.includes(lower)) return i;
  }
  return undefined;
}
