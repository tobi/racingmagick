import { test, expect, describe } from 'bun:test';
import { VBOExporter, exportToCSV, exportToMotecLD } from './exporters';
import type { VBOSession, VBODataPoint } from './types';

// Helper function to create mock session data
function createMockSession(): VBOSession {
  const dataPoints: VBODataPoint[] = [];
  const baseTime = 0;

  // Create 100 mock data points (10 seconds @ 10 Hz)
  for (let i = 0; i < 100; i++) {
    dataPoints.push({
      satellites: 12,
      time: baseTime + i * 0.1,
      latitude: 52.0700 + i * 0.0001,
      longitude: -1.0200 - i * 0.0001,
      velocity: 120 + Math.sin(i * 0.1) * 20,
      heading: 180 + Math.sin(i * 0.05) * 30,
      height: 150.5,
      verticalVelocity: 0.1,
      samplePeriod: 0.1,
      solutionType: 4,
      aviFileIndex: 0,
      aviSyncTime: 0,
      comboAcc: 1.5,
      tcSlip: 0,
      tcGain: 0,
      ppsMap: 0,
      epsMap: 0,
      engMap: 1,
      driverId: 1,
      ambientTemperature: 22.5,
      carOnJack: 0,
      headrest: 0,
      fuelProbe: 85,
      tcActive: 0,
      lapNumber: 1,
      lapGainLoss: 0,
      engineSpeed: 6500 + Math.sin(i * 0.2) * 1000,
      steeringAngle: Math.sin(i * 0.15) * 45,
      brakePressureFront: i % 20 < 5 ? 8.5 : 0,
      throttlePedal: i % 20 < 5 ? 0 : 85,
      vehicleSpeed: 120 + Math.sin(i * 0.1) * 20,
      gear: Math.floor((i % 50) / 10) + 3,
      comboG: 1.2,
    });
  }

  return {
    filePath: '/test/session.vbo',
    videos: [],
    header: {
      creationDate: new Date('2023-12-15T14:30:25Z'),
      channels: [
        { name: 'Time', unit: 's', index: 0 },
        { name: 'Velocity', unit: 'km/h', index: 1 },
        { name: 'Engine Speed', unit: 'rpm', index: 2 },
      ],
      units: ['s', 'km/h', 'rpm'],
      sampleRate: 10,
      driverId: 'TEST-001',
      vehicle: 'Test Car',
      version: '1.0',
    },
    dataPoints,
    laps: [
      {
        lapNumber: 1,
        startTime: 0,
        endTime: 5,
        lapTime: 5,
        distance: 3500,
        sectors: [],
        dataPoints: dataPoints.slice(0, 50),
        isValid: true,
        label: 'timed-lap',
      },
      {
        lapNumber: 2,
        startTime: 5,
        endTime: 10,
        lapTime: 5,
        distance: 3500,
        sectors: [],
        dataPoints: dataPoints.slice(50, 100),
        isValid: true,
        label: 'timed-lap',
      },
    ],
    fastestLap: undefined,
    totalTime: 10,
    trackLength: 3500,
    circuitInfo: {
      country: 'UK',
      circuit: 'Test Track',
      timingLines: [],
    },
  };
}

describe('VBOExporter', () => {
  describe('CSV Export', () => {
    test('should create exporter instance', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      expect(exporter).toBeInstanceOf(VBOExporter);
    });

    test('should export basic CSV with time in first column', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const csv = exporter.toCSV({
        channels: ['time', 'velocity', 'engineSpeed'],
      });

      const lines = csv.split('\n');

      // Check header
      expect(lines[0]).toContain('Time');
      expect(lines[0]).toContain('Velocity');
      expect(lines[0]).toContain('Engine Speed');

      // Check first data row
      const firstRow = lines[1].split(',');
      expect(firstRow[0]).toBe('0.000'); // Time starts at 0.000
      expect(parseFloat(firstRow[1])).toBeGreaterThan(0); // Velocity
      expect(parseFloat(firstRow[2])).toBeGreaterThan(0); // Engine speed
    });

    test('should format time with specified decimal places', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const csv = exporter.toCSV({
        channels: ['time', 'velocity'],
        decimalPlaces: 5,
      });

      const lines = csv.split('\n');
      const secondRow = lines[2].split(',');

      // Second data point should be at time 0.10000 (5 decimal places)
      expect(secondRow[0]).toBe('0.10000');
    });

    test('should support custom delimiter', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const csv = exporter.toCSV({
        channels: ['time', 'velocity'],
        delimiter: ';',
      });

      const lines = csv.split('\n');
      expect(lines[0]).toContain(';');
      expect(lines[1]).toContain(';');
    });

    test('should export without headers when requested', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const csv = exporter.toCSV({
        channels: ['time', 'velocity'],
        includeHeaders: false,
      });

      const lines = csv.split('\n');
      const firstRow = lines[0].split(',');

      // First row should be numeric data, not headers
      expect(parseFloat(firstRow[0])).toBe(0);
      expect(parseFloat(firstRow[1])).toBeGreaterThan(0);
    });

    test('should include units in header when requested', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const csv = exporter.toCSV({
        channels: ['time', 'velocity'],
        includeUnitsInHeader: true,
      });

      const lines = csv.split('\n');
      expect(lines[0]).toContain('(s)');
      expect(lines[0]).toContain('(km/h)');
    });

    test('should exclude units from header when requested', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const csv = exporter.toCSV({
        channels: ['time', 'velocity'],
        includeUnitsInHeader: false,
      });

      const lines = csv.split('\n');
      expect(lines[0]).not.toContain('(s)');
      expect(lines[0]).not.toContain('(km/h)');
      expect(lines[0]).toContain('Time');
      expect(lines[0]).toContain('Velocity');
    });

    test('should export only specified lap', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const csv = exporter.toCSV({
        channels: ['time', 'velocity'],
        lapNumber: 1,
      });

      const lines = csv.split('\n');

      // Lap 1 has 50 data points, plus 1 header row = 51 lines
      expect(lines.length).toBe(51);
    });

    test('should throw error for non-existent lap', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);

      expect(() => {
        exporter.toCSV({
          channels: ['time', 'velocity'],
          lapNumber: 999,
        });
      }).toThrow('Lap 999 not found');
    });

    test('should export in milliseconds when requested', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const csv = exporter.toCSV({
        channels: ['time', 'velocity'],
        timeFormat: 'milliseconds',
      });

      const lines = csv.split('\n');
      const secondRow = lines[2].split(',');

      // Second data point at 0.1s = 100ms
      expect(secondRow[0]).toBe('100.000');
    });

    test('should always include time column even if not specified', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const csv = exporter.toCSV({
        channels: ['velocity', 'engineSpeed'], // Time not specified
      });

      const lines = csv.split('\n');
      expect(lines[0]).toContain('Time'); // Time should still be present
    });

    test('should handle empty data gracefully', () => {
      const session = createMockSession();
      session.dataPoints = [];
      const exporter = new VBOExporter(session);

      expect(() => {
        exporter.toCSV();
      }).toThrow('No data points available');
    });

    test('should export all default channels when none specified', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const csv = exporter.toCSV();

      const lines = csv.split('\n');
      const header = lines[0];

      // Should include common channels
      expect(header).toContain('Time');
      expect(header).toContain('Velocity');
      expect(header).toContain('Engine Speed');
      expect(header).toContain('Throttle');
    });
  });

  describe('MoTeC LD Export', () => {
    test('should export to MoTeC LD binary format', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const ldData = exporter.toMotecLD({
        channels: ['time', 'velocity', 'engineSpeed'],
      });

      expect(ldData).toBeInstanceOf(Uint8Array);
      expect(ldData.length).toBeGreaterThan(1536); // Minimum header size
    });

    test('should auto-populate metadata from session', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);

      // Export with no options - should use session data
      const ldData = exporter.toMotecLD();

      const decoder = new TextDecoder();
      const text = decoder.decode(ldData.slice(0, 1536));

      // Should include data from session
      expect(text).toContain('TEST-001'); // driverId from session
      expect(text).toContain('Test Car'); // vehicle from session
      expect(text).toContain('Test Track'); // circuit from session
      expect(text).toContain('UK'); // country from session
    });

    test('should auto-generate comment with session stats', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);

      // Export with no comment - should auto-generate
      const ldData = exporter.toMotecLD();

      const decoder = new TextDecoder();
      const text = decoder.decode(ldData.slice(0, 1536));

      // Should include auto-generated comment with lap count and duration
      expect(text).toContain('VBO Export'); // Source marker
    });

    test('should auto-generate lap-specific comment', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);

      // Export single lap - should generate lap-specific comment
      const ldData = exporter.toMotecLD({
        lapNumber: 1,
      });

      const decoder = new TextDecoder();
      const text = decoder.decode(ldData.slice(0, 1536));

      // Should include lap number in comment
      expect(text).toContain('Lap 1');
    });

    test('should write correct header marker', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const ldData = exporter.toMotecLD({
        channels: ['time', 'velocity'],
      });

      const view = new DataView(ldData.buffer);
      const marker = view.getUint32(0, true);

      expect(marker).toBe(0x40);
    });

    test('should include metadata in header', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const ldData = exporter.toMotecLD({
        driverName: 'John Doe',
        vehicleId: 'Car #42',
        venue: 'Silverstone',
        channels: ['time', 'velocity'],
      });

      // Check driver name is present in header (offset varies)
      const decoder = new TextDecoder();
      const text = decoder.decode(ldData.slice(0, 1536));

      expect(text).toContain('John Doe');
      expect(text).toContain('Car #42');
      expect(text).toContain('Silverstone');
    });

    test('should write correct channel count', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const ldData = exporter.toMotecLD({
        channels: ['time', 'velocity', 'engineSpeed'],
      });

      const view = new DataView(ldData.buffer);
      const channelCount = view.getUint16(16, true);

      expect(channelCount).toBe(3);
    });

    test('should handle single lap export', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const ldData = exporter.toMotecLD({
        channels: ['time', 'velocity'],
        lapNumber: 1,
      });

      expect(ldData).toBeInstanceOf(Uint8Array);
      expect(ldData.length).toBeGreaterThan(0);
    });

    test('should set default metadata when not provided', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const ldData = exporter.toMotecLD({
        channels: ['time', 'velocity'],
      });

      const decoder = new TextDecoder();
      const text = decoder.decode(ldData.slice(0, 1536));

      expect(text).toContain('VBO-PARSER'); // Default serial
      expect(text).toContain('VBO'); // Default device type
    });

    test('should truncate metadata strings to max length', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const longName = 'A'.repeat(100); // Longer than 64 char limit

      const ldData = exporter.toMotecLD({
        driverName: longName,
        channels: ['time', 'velocity'],
      });

      // Should not throw, should truncate gracefully
      expect(ldData).toBeInstanceOf(Uint8Array);
    });

    test('should write channel metadata correctly', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const ldData = exporter.toMotecLD({
        channels: ['time', 'velocity', 'engineSpeed'],
      });

      // Channel metadata starts at offset 1536
      const view = new DataView(ldData.buffer);

      // First channel metadata
      const prevPointer = view.getUint32(1536, true);
      const nextPointer = view.getUint32(1536 + 4, true);

      expect(prevPointer).toBe(0); // First channel has no previous
      expect(nextPointer).toBe(1536 + 128); // Points to next channel
    });

    test('should throw error for empty data', () => {
      const session = createMockSession();
      session.dataPoints = [];
      const exporter = new VBOExporter(session);

      expect(() => {
        exporter.toMotecLD();
      }).toThrow('No data points available');
    });

    test('should include all default channels when none specified', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const ldData = exporter.toMotecLD();

      const view = new DataView(ldData.buffer);
      const channelCount = view.getUint16(16, true);

      // Should have many channels by default
      expect(channelCount).toBeGreaterThan(10);
    });

    test('should format date correctly for MoTeC', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const ldData = exporter.toMotecLD({
        channels: ['time', 'velocity'],
      });

      const decoder = new TextDecoder();
      const headerText = decoder.decode(ldData.slice(0, 200));

      // Should contain date in DD/MM/YYYY format
      expect(headerText).toMatch(/\d{2}\/\d{2}\/\d{4}/);
    });
  });

  describe('Convenience Functions', () => {
    test('exportToCSV should work as standalone function', () => {
      const session = createMockSession();
      const csv = exportToCSV(session, {
        channels: ['time', 'velocity'],
      });

      expect(csv).toContain('Time');
      expect(csv).toContain('Velocity');
    });

    test('exportToMotecLD should work as standalone function', () => {
      const session = createMockSession();
      const ldData = exportToMotecLD(session, {
        channels: ['time', 'velocity'],
      });

      expect(ldData).toBeInstanceOf(Uint8Array);
      expect(ldData.length).toBeGreaterThan(1536);
    });
  });

  describe('Channel Mapping', () => {
    test('should correctly map VBO channels to display names', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const csv = exporter.toCSV({
        channels: ['engineSpeed', 'throttlePedal', 'brakePressureFront'],
        includeUnitsInHeader: true,
      });

      const lines = csv.split('\n');
      const header = lines[0];

      expect(header).toContain('Engine Speed');
      expect(header).toContain('rpm');
      expect(header).toContain('Throttle');
      expect(header).toContain('%');
      expect(header).toContain('Brake Pressure');
      expect(header).toContain('bar');
    });

    test('should handle channels without units', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const csv = exporter.toCSV({
        channels: ['gear', 'satellites'],
        includeUnitsInHeader: true,
      });

      const lines = csv.split('\n');
      const header = lines[0];

      expect(header).toContain('Gear');
      expect(header).toContain('Satellites');
      // Should not have empty parentheses for unitless channels
      expect(header).not.toContain('()');
    });
  });

  describe('Data Integrity', () => {
    test('should maintain data precision in CSV export', () => {
      const session = createMockSession();
      const exporter = new VBOExporter(session);
      const csv = exporter.toCSV({
        channels: ['time', 'velocity'],
        decimalPlaces: 6,
      });

      const lines = csv.split('\n');
      const thirdRow = lines[3].split(',');

      // Third data point at time 0.2
      expect(thirdRow[0]).toBe('0.200000');
    });

    test('should export relative time starting from 0', () => {
      const session = createMockSession();
      // Modify first data point to have non-zero time
      session.dataPoints[0].time = 100;
      session.dataPoints[1].time = 100.1;

      const exporter = new VBOExporter(session);
      const csv = exporter.toCSV({
        channels: ['time', 'velocity'],
      });

      const lines = csv.split('\n');
      const firstRow = lines[1].split(',');
      const secondRow = lines[2].split(',');

      // Time should be relative to first data point
      expect(firstRow[0]).toBe('0.000');
      expect(secondRow[0]).toBe('0.100');
    });
  });
});
