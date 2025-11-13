/**
 * @fileoverview Data exporters for VBO telemetry data
 *
 * This module provides comprehensive export functionality for VBO telemetry data
 * to various formats used in motorsport data analysis:
 *
 * 1. **CSV Export** - Standard CSV format with time always in the first column
 * 2. **MoTeC i2 Pro LD Format** - Binary format compatible with MoTeC i2 analysis software
 *
 * @module exporters
 */

import type { VBOSession, VBODataPoint, VBOVideoFile } from './types';

/**
 * Export format types supported by the exporters
 */
export type ExportFormat = 'csv' | 'motec-ld';

/**
 * Options for CSV export
 */
export interface CSVExportOptions {
  /**
   * Delimiter to use between columns
   * @default ','
   */
  delimiter?: string;

  /**
   * Whether to include header row with channel names
   * @default true
   */
  includeHeaders?: boolean;

  /**
   * Number of decimal places for numeric values
   * @default 3
   */
  decimalPlaces?: number;

  /**
   * Whether to include units in header (e.g., "Speed (km/h)")
   * @default true
   */
  includeUnitsInHeader?: boolean;

  /**
   * Specific channels to export (if not specified, exports all available)
   * Channel names should match VBODataPoint property names
   */
  channels?: (keyof VBODataPoint)[];

  /**
   * Export only a specific lap (if not specified, exports all data)
   */
  lapNumber?: number;

  /**
   * Time column format
   * - 'seconds': Time in seconds (0.000 format)
   * - 'milliseconds': Time in milliseconds
   * @default 'seconds'
   */
  timeFormat?: 'seconds' | 'milliseconds';
}

/**
 * Options for MoTeC LD binary export
 */
export interface MotecLDExportOptions {
  /**
   * Driver name (max 64 characters)
   */
  driverName?: string;

  /**
   * Vehicle ID (max 64 characters)
   */
  vehicleId?: string;

  /**
   * Venue/track name (max 64 characters)
   */
  venue?: string;

  /**
   * Short comment about the session (max 64 characters)
   */
  comment?: string;

  /**
   * Device serial number
   * @default 'VBO-PARSER'
   */
  serialNumber?: string;

  /**
   * Device type identifier
   * @default 'VBO'
   */
  deviceType?: string;

  /**
   * Specific channels to export (if not specified, exports all available)
   */
  channels?: (keyof VBODataPoint)[];

  /**
   * Export only a specific lap
   */
  lapNumber?: number;
}

/**
 * Channel metadata for MoTeC LD format
 */
interface MotecChannel {
  name: string;
  shortName: string;
  unit: string;
  dataType: 'float32' | 'int16' | 'int32';
  frequency: number;
  shift: number;
  multiplier: number;
  scale: number;
  decimalPlaces: number;
}

/**
 * Main exporter class for VBO telemetry data
 */
export class VBOExporter {
  private session: VBOSession;

  constructor(session: VBOSession) {
    this.session = session;
  }

  /**
   * Export session data to CSV format with time always in the first column
   *
   * CSV Format specification:
   * - First column is ALWAYS time (in seconds by default, 3 decimal places)
   * - Time starts at 0.000 for the first data point
   * - Subsequent columns are telemetry channels
   * - Headers include channel names and optionally units
   *
   * @param options - CSV export options
   * @returns CSV string data
   *
   * @example
   * ```typescript
   * const exporter = new VBOExporter(session);
   * const csvData = exporter.toCSV({
   *   channels: ['time', 'velocity', 'engineSpeed', 'throttlePedal'],
   *   decimalPlaces: 3
   * });
   * ```
   */
  public toCSV(options: CSVExportOptions = {}): string {
    const {
      delimiter = ',',
      includeHeaders = true,
      decimalPlaces = 3,
      includeUnitsInHeader = true,
      channels,
      lapNumber,
      timeFormat = 'seconds',
    } = options;

    // Get data points to export
    const dataPoints = this.getDataPointsForExport(lapNumber);

    if (dataPoints.length === 0) {
      throw new Error('No data points available for export');
    }

    // Determine which channels to export
    const exportChannels = this.getExportChannels(channels);

    // Build CSV content
    const lines: string[] = [];

    // Add header row if requested
    if (includeHeaders) {
      const headerCols = ['Time'];

      for (const channel of exportChannels) {
        if (channel === 'time') continue; // Already added

        const channelInfo = this.getChannelInfo(channel);
        let headerName = channelInfo.name;

        if (includeUnitsInHeader && channelInfo.unit) {
          headerName += ` (${channelInfo.unit})`;
        }

        headerCols.push(headerName);
      }

      lines.push(headerCols.join(delimiter));
    }

    // Add data rows
    const firstTime = dataPoints[0].time;

    for (const point of dataPoints) {
      const row: string[] = [];

      // Time column (always first, relative to start)
      const relativeTime = point.time - firstTime;
      const timeValue = timeFormat === 'milliseconds'
        ? relativeTime * 1000
        : relativeTime;
      row.push(timeValue.toFixed(decimalPlaces));

      // Data columns
      for (const channel of exportChannels) {
        if (channel === 'time') continue; // Already added

        const value = point[channel];
        if (typeof value === 'number') {
          row.push(value.toFixed(decimalPlaces));
        } else {
          row.push(String(value ?? ''));
        }
      }

      lines.push(row.join(delimiter));
    }

    return lines.join('\n');
  }

  /**
   * Export session data to MoTeC i2 Pro LD binary format
   *
   * The LD format is a proprietary binary format used by MoTeC i2 data analysis software.
   * This implementation is based on reverse-engineered specifications.
   *
   * Format structure:
   * - Header (1536 bytes): File metadata, channel count, timestamps
   * - Channel metadata (128 bytes per channel): Linked list of channel definitions
   * - Channel data: Binary data for each channel
   *
   * @param options - MoTeC LD export options
   * @returns Uint8Array containing the binary LD file data
   *
   * @example
   * ```typescript
   * const exporter = new VBOExporter(session);
   * const ldData = exporter.toMotecLD({
   *   driverName: 'John Doe',
   *   vehicleId: 'Car #42',
   *   venue: 'Silverstone GP',
   *   channels: ['time', 'velocity', 'engineSpeed']
   * });
   * // Write to file or download
   * ```
   */
  public toMotecLD(options: MotecLDExportOptions = {}): Uint8Array {
    // Auto-populate metadata from session if not provided
    const driverName = options.driverName ?? this.session.header.driverId ?? '';
    const vehicleId = options.vehicleId ?? this.session.header.vehicle ?? '';

    // Build venue from circuit info
    let venue = options.venue;
    if (!venue) {
      const parts: string[] = [];
      if (this.session.circuitInfo.circuit) {
        parts.push(this.session.circuitInfo.circuit);
      }
      if (this.session.circuitInfo.country) {
        parts.push(this.session.circuitInfo.country);
      }
      venue = parts.join(', ') || '';
    }

    // Build informative comment from session data
    let comment = options.comment;
    if (!comment) {
      const parts: string[] = [];

      // Add lap info if exporting single lap
      if (options.lapNumber !== undefined) {
        const lap = this.session.laps.find((l) => l.lapNumber === options.lapNumber);
        if (lap) {
          parts.push(`Lap ${lap.lapNumber}: ${lap.lapTime.toFixed(3)}s`);
          if (lap.label !== 'timed-lap') {
            parts.push(`(${lap.label})`);
          }
        }
      } else {
        // Full session info
        if (this.session.laps.length > 0) {
          parts.push(`${this.session.laps.length} laps`);
        }
        parts.push(`${this.session.totalTime.toFixed(1)}s`);
      }

      // Add source info
      parts.push('VBO Export');

      comment = parts.join(' - ');
    }

    const {
      serialNumber = 'VBO-PARSER',
      deviceType = 'VBO',
      channels,
      lapNumber,
    } = options;

    // Get data points to export
    const dataPoints = this.getDataPointsForExport(lapNumber);

    if (dataPoints.length === 0) {
      throw new Error('No data points available for export');
    }

    // Determine which channels to export
    const exportChannels = this.getExportChannels(channels);

    // Build MoTeC channel definitions
    const motecChannels = this.buildMotecChannels(exportChannels, dataPoints);

    // Calculate file size
    const headerSize = 1536;
    const channelMetadataSize = 128 * motecChannels.length;
    const channelDataSize = motecChannels.reduce((sum, ch) => {
      const bytesPerSample = this.getBytesPerSample(ch.dataType);
      return sum + (dataPoints.length * bytesPerSample);
    }, 0);

    const totalSize = headerSize + channelMetadataSize + channelDataSize;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);

    // Write header
    this.writeMotecHeader(view, uint8, {
      channelCount: motecChannels.length,
      dataPoints: dataPoints.length,
      driverName,
      vehicleId,
      venue,
      comment,
      serialNumber,
      deviceType,
      videos: this.session.videos,
    });

    // Write channel metadata and data
    let metadataOffset = headerSize;
    let dataOffset = headerSize + channelMetadataSize;

    for (let i = 0; i < motecChannels.length; i++) {
      const channel = motecChannels[i];
      if (!channel) continue;

      const nextMetadataOffset = i < motecChannels.length - 1
        ? metadataOffset + 128
        : 0;
      const prevMetadataOffset = i > 0 ? metadataOffset - 128 : 0;

      // Write channel metadata
      this.writeMotecChannelMetadata(view, uint8, metadataOffset, {
        channel,
        dataOffset,
        dataLength: dataPoints.length * this.getBytesPerSample(channel.dataType),
        prevOffset: prevMetadataOffset,
        nextOffset: nextMetadataOffset,
      });

      // Write channel data
      const vboChannel = exportChannels[i];
      if (!vboChannel) continue;

      this.writeMotecChannelData(
        view,
        dataOffset,
        channel,
        dataPoints,
        vboChannel
      );

      metadataOffset = nextMetadataOffset;
      dataOffset += dataPoints.length * this.getBytesPerSample(channel.dataType);
    }

    return new Uint8Array(buffer);
  }

  /**
   * Get data points for export (all or specific lap)
   */
  private getDataPointsForExport(lapNumber?: number): VBODataPoint[] {
    if (lapNumber !== undefined) {
      const lap = this.session.laps.find((l) => l.lapNumber === lapNumber);
      if (!lap) {
        throw new Error(`Lap ${lapNumber} not found in session`);
      }
      return lap.dataPoints;
    }

    return this.session.dataPoints;
  }

  /**
   * Get list of channels to export
   */
  private getExportChannels(requestedChannels?: (keyof VBODataPoint)[]): (keyof VBODataPoint)[] {
    if (requestedChannels && requestedChannels.length > 0) {
      // Always ensure 'time' is included
      if (!requestedChannels.includes('time')) {
        return ['time', ...requestedChannels];
      }
      return requestedChannels;
    }

    // Export all numeric channels by default
    const allChannels: (keyof VBODataPoint)[] = [
      'time',
      'satellites',
      'latitude',
      'longitude',
      'velocity',
      'heading',
      'height',
      'verticalVelocity',
      'samplePeriod',
      'aviFileIndex',  // Video sync: which video file
      'aviSyncTime',   // Video sync: timestamp in video
      'engineSpeed',
      'vehicleSpeed',
      'throttlePedal',
      'brakePressureFront',
      'steeringAngle',
      'gear',
      'comboAcc',
      'comboG',
      'tcSlip',
      'tcGain',
      'tcActive',
      'ambientTemperature',
    ];

    return allChannels;
  }

  /**
   * Get channel information (name and unit)
   */
  private getChannelInfo(channel: keyof VBODataPoint): { name: string; unit: string } {
    const channelMap: Partial<Record<keyof VBODataPoint, { name: string; unit: string }>> = {
      time: { name: 'Time', unit: 's' },
      satellites: { name: 'Satellites', unit: '' },
      latitude: { name: 'Latitude', unit: 'deg' },
      longitude: { name: 'Longitude', unit: 'deg' },
      velocity: { name: 'Velocity', unit: 'km/h' },
      heading: { name: 'Heading', unit: 'deg' },
      height: { name: 'Height', unit: 'm' },
      verticalVelocity: { name: 'Vertical Velocity', unit: 'm/s' },
      samplePeriod: { name: 'Sample Period', unit: 's' },
      engineSpeed: { name: 'Engine Speed', unit: 'rpm' },
      vehicleSpeed: { name: 'Vehicle Speed', unit: 'km/h' },
      throttlePedal: { name: 'Throttle Position', unit: '%' },
      brakePressureFront: { name: 'Brake Pressure', unit: 'bar' },
      steeringAngle: { name: 'Steering Angle', unit: 'deg' },
      gear: { name: 'Gear', unit: '' },
      comboAcc: { name: 'Combined Accel', unit: 'm/s²' },
      comboG: { name: 'Combined G-Force', unit: 'g' },
      tcSlip: { name: 'TC Slip', unit: '%' },
      tcGain: { name: 'TC Gain', unit: '' },
      tcActive: { name: 'TC Active', unit: '' },
      ambientTemperature: { name: 'Ambient Temp', unit: '°C' },
      lapNumber: { name: 'Lap Number', unit: '' },
      solutionType: { name: 'Solution Type', unit: '' },
      aviFileIndex: { name: 'AVI File Index', unit: '' },
      aviSyncTime: { name: 'AVI Sync Time', unit: 's' },
      ppsMap: { name: 'PPS Map', unit: '' },
      epsMap: { name: 'EPS Map', unit: '' },
      engMap: { name: 'Engine Map', unit: '' },
      driverId: { name: 'Driver ID', unit: '' },
      carOnJack: { name: 'Car On Jack', unit: '' },
      headrest: { name: 'Headrest', unit: '' },
      fuelProbe: { name: 'Fuel Level', unit: '%' },
      lapGainLoss: { name: 'Lap Gain/Loss', unit: 's' },
    };

    return channelMap[channel] || { name: String(channel), unit: '' };
  }

  /**
   * Build MoTeC channel definitions from VBO data
   */
  private buildMotecChannels(
    channels: (keyof VBODataPoint)[],
    dataPoints: VBODataPoint[]
  ): MotecChannel[] {
    const motecChannels: MotecChannel[] = [];

    // Calculate approximate sample rate from data
    const sampleRate = dataPoints.length > 1
      ? 1 / (dataPoints[1].time - dataPoints[0].time)
      : 10; // Default 10 Hz

    for (const channel of channels) {
      const info = this.getChannelInfo(channel);

      // Determine optimal data type based on channel characteristics
      let dataType: 'float32' | 'int16' | 'int32' = 'float32';
      let scale = 1;
      let decimalPlaces = 3;

      if (channel === 'gear' || channel === 'satellites' || channel === 'lapNumber') {
        dataType = 'int16';
        scale = 1;
        decimalPlaces = 0;
      } else if (channel === 'engineSpeed') {
        dataType = 'int16';
        scale = 10;
        decimalPlaces = 0;
      } else if (channel === 'tcActive' || channel === 'carOnJack') {
        dataType = 'int16';
        scale = 1;
        decimalPlaces = 0;
      }

      motecChannels.push({
        name: info.name,
        shortName: this.generateShortName(info.name),
        unit: info.unit,
        dataType,
        frequency: sampleRate,
        shift: 0,
        multiplier: 1,
        scale,
        decimalPlaces,
      });
    }

    return motecChannels;
  }

  /**
   * Generate short name (max 8 characters) for MoTeC format
   */
  private generateShortName(name: string): string {
    // Remove spaces and vowels if needed to fit 8 characters
    let short = name.replace(/\s+/g, '');

    if (short.length <= 8) {
      return short;
    }

    // Remove vowels from middle of words
    const words = name.split(' ');
    short = words.map(word => {
      if (word.length <= 3) return word;
      return word[0] + word.slice(1).replace(/[aeiou]/gi, '');
    }).join('');

    if (short.length <= 8) {
      return short;
    }

    // Just truncate
    return short.substring(0, 8);
  }

  /**
   * Get bytes per sample for data type
   */
  private getBytesPerSample(dataType: string): number {
    switch (dataType) {
      case 'int16': return 2;
      case 'int32': return 4;
      case 'float32': return 4;
      default: return 4;
    }
  }

  /**
   * Write MoTeC LD file header (1536 bytes)
   */
  private writeMotecHeader(
    view: DataView,
    uint8: Uint8Array,
    options: {
      channelCount: number;
      dataPoints: number;
      driverName: string;
      vehicleId: string;
      venue: string;
      comment: string;
      serialNumber: string;
      deviceType: string;
      videos: VBOVideoFile[];
    }
  ): void {
    let offset = 0;

    // Marker (0x40)
    view.setUint32(offset, 0x40, true);
    offset += 4;

    // Pointers (will be set based on structure)
    const metadataPointer = 1536; // Right after header
    const dataPointer = 1536 + (options.channelCount * 128);

    view.setUint32(offset, metadataPointer, true); // First channel metadata
    offset += 4;
    view.setUint32(offset, dataPointer, true); // First channel data
    offset += 4;
    view.setUint32(offset, 0, true); // Event pointer (none)
    offset += 4;

    // Channel count
    view.setUint16(offset, options.channelCount, true);
    offset += 2;

    // Padding
    offset += 2;

    // Date/time (DD/MM/YYYY HH:MM:SS format)
    const date = this.session.header.creationDate;
    const dateStr = this.formatMotecDateTime(date);
    this.writeString(uint8, offset, dateStr, 16);
    offset += 16;

    // Driver name (64 bytes)
    this.writeString(uint8, offset, options.driverName, 64);
    offset += 64;

    // Vehicle ID (64 bytes)
    this.writeString(uint8, offset, options.vehicleId, 64);
    offset += 64;

    // Venue (64 bytes)
    this.writeString(uint8, offset, options.venue, 64);
    offset += 64;

    // Short comment (64 bytes)
    this.writeString(uint8, offset, options.comment, 64);
    offset += 64;

    // Device serial number (16 bytes)
    this.writeString(uint8, offset, options.serialNumber, 16);
    offset += 16;

    // Device type (8 bytes)
    this.writeString(uint8, offset, options.deviceType, 8);
    offset += 8;

    // Device version (should be offset 0x30 from start, typically 420)
    view.setUint16(offset, 420, true);
    offset += 2;

    // Video file information (custom extension for VBO compatibility)
    // Using offset 512 to avoid conflicts with standard LD format
    let videoOffset = 512;

    // Write video count
    view.setUint16(videoOffset, Math.min(options.videos.length, 10), true);
    videoOffset += 2;

    // Write video filenames (up to 10 videos, 128 bytes each for filename)
    for (let i = 0; i < Math.min(options.videos.length, 10); i++) {
      const video = options.videos[i];
      if (video) {
        // Extract just the filename (remove path)
        const filename = video.filename.split('/').pop() || video.filename;
        this.writeString(uint8, videoOffset, filename, 128);
        videoOffset += 128;
      }
    }

    // Fill rest of header with zeros (handled by ArrayBuffer initialization)
  }

  /**
   * Write MoTeC channel metadata (128 bytes)
   */
  private writeMotecChannelMetadata(
    view: DataView,
    uint8: Uint8Array,
    offset: number,
    options: {
      channel: MotecChannel;
      dataOffset: number;
      dataLength: number;
      prevOffset: number;
      nextOffset: number;
    }
  ): void {
    let pos = offset;

    // Previous channel metadata pointer
    view.setUint32(pos, options.prevOffset, true);
    pos += 4;

    // Next channel metadata pointer
    view.setUint32(pos, options.nextOffset, true);
    pos += 4;

    // Data offset
    view.setUint32(pos, options.dataOffset, true);
    pos += 4;

    // Data length
    view.setUint32(pos, options.dataLength, true);
    pos += 4;

    // Data type encoding
    const typeCode = this.getMotecTypeCode(options.channel.dataType);
    view.setUint16(pos, typeCode, true);
    pos += 2;
    view.setUint16(pos, typeCode === 0x07 ? 0x07 : 0x03, true);
    pos += 2;

    // Frequency
    view.setUint16(pos, Math.round(options.channel.frequency), true);
    pos += 2;

    // Shift
    view.setFloat32(pos, options.channel.shift, true);
    pos += 4;

    // Multiplier
    view.setFloat32(pos, options.channel.multiplier, true);
    pos += 4;

    // Scale
    view.setFloat32(pos, options.channel.scale, true);
    pos += 4;

    // Decimal places
    view.setUint16(pos, options.channel.decimalPlaces, true);
    pos += 2;

    // Padding
    pos += 2;

    // Channel name (32 bytes)
    this.writeString(uint8, pos, options.channel.name, 32);
    pos += 32;

    // Short name (8 bytes)
    this.writeString(uint8, pos, options.channel.shortName, 8);
    pos += 8;

    // Unit (12 bytes)
    this.writeString(uint8, pos, options.channel.unit, 12);
    pos += 12;

    // Rest is padding (handled by ArrayBuffer initialization)
  }

  /**
   * Write MoTeC channel data
   */
  private writeMotecChannelData(
    view: DataView,
    offset: number,
    channel: MotecChannel,
    dataPoints: VBODataPoint[],
    vboChannel: keyof VBODataPoint
  ): void {
    let pos = offset;

    for (const point of dataPoints) {
      const value = point[vboChannel] as number;
      const scaledValue = Math.round((value - channel.shift) / channel.multiplier * channel.scale);

      switch (channel.dataType) {
        case 'int16':
          view.setInt16(pos, scaledValue, true);
          pos += 2;
          break;
        case 'int32':
          view.setInt32(pos, scaledValue, true);
          pos += 4;
          break;
        case 'float32':
          view.setFloat32(pos, value, true);
          pos += 4;
          break;
      }
    }
  }

  /**
   * Get MoTeC data type code
   */
  private getMotecTypeCode(dataType: string): number {
    switch (dataType) {
      case 'float32': return 0x07;
      case 'int16': return 0x03;
      case 'int32': return 0x05;
      default: return 0x07;
    }
  }

  /**
   * Format date/time for MoTeC (DD/MM/YYYY HH:MM:SS)
   */
  private formatMotecDateTime(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');

    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
           `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  /**
   * Write null-terminated string to buffer
   */
  private writeString(uint8: Uint8Array, offset: number, str: string, maxLength: number): void {
    const truncated = str.substring(0, maxLength - 1);

    for (let i = 0; i < truncated.length; i++) {
      uint8[offset + i] = truncated.charCodeAt(i);
    }

    // Null terminator (rest of buffer is already zeros)
    uint8[offset + truncated.length] = 0;
  }
}

/**
 * Convenience function to export VBO session to CSV
 *
 * @param session - VBO session to export
 * @param options - CSV export options
 * @returns CSV string data
 *
 * @example
 * ```typescript
 * import { exportToCSV } from '@vbo-parser/core';
 *
 * const csv = exportToCSV(session, {
 *   channels: ['time', 'velocity', 'engineSpeed'],
 *   lapNumber: 5
 * });
 * ```
 */
export function exportToCSV(session: VBOSession, options?: CSVExportOptions): string {
  const exporter = new VBOExporter(session);
  return exporter.toCSV(options);
}

/**
 * Convenience function to export VBO session to MoTeC LD format
 *
 * @param session - VBO session to export
 * @param options - MoTeC LD export options
 * @returns Uint8Array containing binary LD file data
 *
 * @example
 * ```typescript
 * import { exportToMotecLD } from '@vbo-parser/core';
 *
 * const ldData = exportToMotecLD(session, {
 *   driverName: 'John Doe',
 *   vehicleId: 'Car #42',
 *   venue: 'Silverstone GP'
 * });
 *
 * // In Node.js:
 * import { writeFileSync } from 'fs';
 * writeFileSync('session.ld', ldData);
 *
 * // In browser:
 * const blob = new Blob([ldData], { type: 'application/octet-stream' });
 * const url = URL.createObjectURL(blob);
 * // Use url for download
 * ```
 */
export function exportToMotecLD(
  session: VBOSession,
  options?: MotecLDExportOptions
): Uint8Array {
  const exporter = new VBOExporter(session);
  return exporter.toMotecLD(options);
}
