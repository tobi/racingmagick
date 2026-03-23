/**
 * VBO file writer — export any Session as a VBOX .vbo text file.
 *
 * This enables converting MoTeC (.ld) and PDS (.pds) telemetry into
 * the universal VBO format that VBOX tools can read.
 */

import { writeFileSync, copyFileSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';
import type { Session } from '../session';

/**
 * Write a Session to a .vbo file.
 *
 * @param session - The parsed session to export
 * @param directory - Output directory
 * @param filename - Output filename (without extension)
 * @returns Path to the written .vbo file
 */
export function saveVbo(session: Session, directory: string, filename: string): string {
  const outPath = join(directory, filename + '.vbo');
  const content = buildVboContent(session);
  writeFileSync(outPath, content, 'utf-8');
  return outPath;
}

/**
 * Write a Session to a .vbo file and copy/link associated video files.
 *
 * @param session - The parsed session to export
 * @param directory - Output directory
 * @param filename - Output filename (without extension)
 * @returns { vboPath, videoPath[] }
 */
export function saveVboAndVideo(
  session: Session,
  directory: string,
  filename: string,
): { vboPath: string; videoPaths: string[] } {
  const vboPath = saveVbo(session, directory, filename);
  const videoPaths: string[] = [];

  // Copy associated video files
  if (session.video && session.video.files.length > 0) {
    for (let i = 0; i < session.video.files.length; i++) {
      const vf = session.video.files[i]!;
      if (!existsSync(vf.path)) continue;

      const ext = extname(vf.filename) || '.mp4';
      const videoOutName = `${filename}_${String(i + 1).padStart(4, '0')}${ext}`;
      const videoOutPath = join(directory, videoOutName);

      copyFileSync(vf.path, videoOutPath);
      videoPaths.push(videoOutPath);
    }
  }

  return { vboPath, videoPaths };
}

// ── VBO content builder ──────────────────────────────────────────────

function buildVboContent(session: Session): string {
  const lines: string[] = [];
  const matrix = session.matrix;
  const hz = matrix.sampleRate;
  const n = matrix.sampleCount;

  // File created line
  const d = session.date;
  const dateStr = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  const timeStr = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  lines.push(`File created on ${dateStr} @ ${timeStr}`);
  lines.push('');

  // Determine which channels to write
  // Standard VBO columns: sats time lat long velocity heading height vert-vel sampleperiod solution_type
  // Plus any ECU channels we have
  const vboColumns = buildColumnMap(session);

  // [header] section — channel names (no spaces)
  lines.push('[header]');
  for (const col of vboColumns) {
    lines.push(col.vboName.replace(/\s+/g, '_'));
  }
  lines.push('');

  // [channel units] section
  lines.push('[channel units]');
  for (const col of vboColumns) {
    lines.push(col.unit || '(null)');
  }
  lines.push('');

  // [comments] section
  lines.push('[comments]');
  lines.push(`Converted by racingmagick from ${session.format} format`);
  if (session.driver) lines.push(`Driver: ${session.driver}`);
  if (session.vehicle) lines.push(`Vehicle: ${session.vehicle}`);
  if (session.track) lines.push(`Track: ${session.track}`);
  lines.push('');

  // [column names] section — names MUST NOT contain spaces (VBO is space-delimited)
  lines.push('[column names]');
  lines.push(vboColumns.map(c => c.vboName.replace(/\s+/g, '_')).join(' '));
  lines.push('');

  // [laptiming] section
  if (session.circuit?.timingLines.length) {
    lines.push('[laptiming]');
    for (const tl of session.circuit.timingLines) {
      const type = tl.type === 'start' ? 'Start' : 'Split';
      lines.push(`${type} +${tl.start.lon.toFixed(7)} +${tl.start.lat.toFixed(7)} +${tl.end.lon.toFixed(7)} +${tl.end.lat.toFixed(7)} \xac ${tl.name}`);
    }
    lines.push('');
  }

  // [data] section
  lines.push('[data]');

  const timeRow = matrix.channels[0]; // time
  const baseTime = timeRow[0]!;

  for (let i = 0; i < n; i++) {
    const values: string[] = [];
    for (const col of vboColumns) {
      values.push(col.format(i, matrix, session, hz, baseTime));
    }
    lines.push(values.join(' '));
  }

  return lines.join('\n') + '\n';
}

// ── Column definitions ───────────────────────────────────────────────

interface VboColumn {
  vboName: string;
  unit: string;
  format: (i: number, matrix: any, session: Session, hz: number, baseTime: number) => string;
}

function buildColumnMap(session: Session): VboColumn[] {
  const matrix = session.matrix;
  const cols: VboColumn[] = [];

  // satellites
  cols.push({
    vboName: 'satellites',
    unit: '',
    format: (i) => {
      const row = matrix.row('gpsSatellites');
      return row ? String(Math.round(row[i]!)) : '0';
    },
  });

  // time — VBO uses HHMMSS.mmm format
  cols.push({
    vboName: 'time',
    unit: '',
    format: (i, m, s, hz, baseTime) => {
      const sessionSecs = matrix.channels[0][i]!;
      // Convert session time to absolute time of day
      const absSeconds = session.date.getHours() * 3600 + session.date.getMinutes() * 60 +
        session.date.getSeconds() + sessionSecs;
      const h = Math.floor(absSeconds / 3600) % 24;
      const min = Math.floor((absSeconds % 3600) / 60);
      const sec = absSeconds % 60;
      return `${pad2(h)}${pad2(min)}${sec.toFixed(3).padStart(6, '0')}`;
    },
  });

  // latitude — VBO uses NMEA DDMM.MMMMM format (or decimal if no GPS)
  cols.push({
    vboName: 'latitude',
    unit: '',
    format: (i) => {
      const row = matrix.row('gpsLat');
      if (!row || row[i] === 0) return '+0000.00000000';
      return formatNmea(row[i]!);
    },
  });

  // longitude
  cols.push({
    vboName: 'longitude',
    unit: '',
    format: (i) => {
      const row = matrix.row('gpsLon');
      if (!row || row[i] === 0) return '+00000.00000000';
      return formatNmea(row[i]!);
    },
  });

  // velocity (km/h)
  cols.push({
    vboName: 'velocity_kmh',
    unit: 'km/h',
    format: (i) => {
      const v = matrix.channels[3][i]!; // speed
      return formatSci(v);
    },
  });

  // heading (degrees)
  cols.push({
    vboName: 'heading',
    unit: '',
    format: (i) => {
      const row = matrix.row('heading');
      return row ? row[i]!.toFixed(3).padStart(7, '0') : '000.000';
    },
  });

  // height (meters)
  cols.push({
    vboName: 'height',
    unit: '',
    format: (i) => {
      const row = matrix.row('gpsAlt');
      return row ? formatSigned(row[i]!, 2) : '+00000.00';
    },
  });

  // vertical velocity
  cols.push({
    vboName: 'vertical_velocity_m/s',
    unit: 'm/s',
    format: () => '+0000.00',
  });

  // sample period
  cols.push({
    vboName: 'sampleperiod',
    unit: '',
    format: (_, __, ___, hz) => (1 / hz).toFixed(4).padStart(5, '0'),
  });

  // solution type
  cols.push({
    vboName: 'solution_type',
    unit: '',
    format: (i) => {
      const row = matrix.row('gpsFix');
      return row ? pad2(Math.round(row[i]!)) : '00';
    },
  });

  // ECU channels — add whatever we have
  const ecuChannels: Array<{ canonical: string; vboName: string; unit: string }> = [
    { canonical: 'speed', vboName: 'Vehicle_Speed', unit: 'km/h' },
    { canonical: 'rpm', vboName: 'Engine_Speed', unit: 'RPM' },
    { canonical: 'throttle', vboName: 'Throttle_Pedal', unit: '%' },
    { canonical: 'brakePressure', vboName: 'Brake_Pressure_Front', unit: 'bar' },
    { canonical: 'steering', vboName: 'Steering_Angle', unit: '' },
    { canonical: 'gear', vboName: 'Gear', unit: '' },
    { canonical: 'gLong', vboName: 'ComboAcc', unit: 'G' },
    { canonical: 'gLat', vboName: 'Combo_G', unit: 'G' },
    // Lap_Number is synthesized from session.laps, not from raw channel
    // { canonical: 'lapNumber', vboName: 'Lap_Number', unit: '' },
    { canonical: 'wheelSpeedFL', vboName: 'whlspeed_FL', unit: 'km/h' },
    { canonical: 'wheelSpeedFR', vboName: 'whlspeed_FR', unit: 'km/h' },
    { canonical: 'wheelSpeedRL', vboName: 'whlspeed_RL', unit: 'km/h' },
    { canonical: 'wheelSpeedRR', vboName: 'whlspeed_RR', unit: 'km/h' },
    { canonical: 'tirePressureFL', vboName: 'Tire_Pressure_FL', unit: 'bar' },
    { canonical: 'tirePressureFR', vboName: 'Tire_Pressure_FR', unit: 'bar' },
    { canonical: 'tirePressureRL', vboName: 'Tire_Pressure_RL', unit: 'bar' },
    { canonical: 'tirePressureRR', vboName: 'Tire_Pressure_RR', unit: 'bar' },
    { canonical: 'tireTempFL', vboName: 'Tire_Temp_FL', unit: 'C' },
    { canonical: 'tireTempFR', vboName: 'Tire_Temp_FR', unit: 'C' },
    { canonical: 'tireTempRL', vboName: 'Tire_Temp_RL', unit: 'C' },
    { canonical: 'tireTempRR', vboName: 'Tire_Temp_RR', unit: 'C' },
  ];

  // Synthesized Lap_Number — increment at each lap boundary so the VBO
  // parser can detect transitions when re-parsing.
  if (session.laps.length > 1) {
    const lapNums = new Float64Array(matrix.sampleCount);
    let currentNum = 1;
    // Fill first lap
    lapNums.fill(currentNum, 0, session.laps[0]!.endIdx);
    for (let l = 1; l < session.laps.length; l++) {
      currentNum++;
      const lap = session.laps[l]!;
      lapNums.fill(currentNum, lap.startIdx, Math.min(lap.endIdx, matrix.sampleCount));
    }
    cols.push({
      vboName: 'Lap_Number',
      unit: '',
      format: (i) => String(Math.round(lapNums[i]!)),
    });
  }

  for (const ecu of ecuChannels) {
    const row = matrix.row(ecu.canonical);
    if (!row) continue;

    cols.push({
      vboName: ecu.vboName,
      unit: ecu.unit,
      format: (i) => {
        let v = row[i]!;
        // Throttle: convert 0-1 ratio back to 0-100% for VBO convention
        if (ecu.canonical === 'throttle') v *= 100;
        // Speed is already in km/h, no conversion needed
        return formatSci(v);
      },
    });
  }

  return cols;
}

// ── Formatting helpers ───────────────────────────────────────────────

function pad2(n: number): string {
  return String(Math.floor(n)).padStart(2, '0');
}

/** Format as VBO scientific notation: +1.234567E+02 */
function formatSci(v: number): string {
  if (!isFinite(v)) return '+0.000000E+00';
  const sign = v >= 0 ? '+' : '';
  return sign + v.toExponential(6).replace('e', 'E');
}

/** Format as signed fixed: +00123.45 */
function formatSigned(v: number, decimals: number): string {
  const sign = v >= 0 ? '+' : '';
  return sign + Math.abs(v).toFixed(decimals).padStart(8, '0');
}

/**
 * Convert decimal degrees to NMEA DDMM.MMMMM format.
 * VBO files typically use NMEA for coordinates.
 */
function formatNmea(decimalDeg: number): string {
  const sign = decimalDeg >= 0 ? '+' : '-';
  const abs = Math.abs(decimalDeg);
  const degrees = Math.floor(abs);
  const minutes = (abs - degrees) * 60;
  return `${sign}${String(degrees).padStart(2, '0')}${minutes.toFixed(8).padStart(11, '0')}`;
}
