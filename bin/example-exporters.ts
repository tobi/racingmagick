#!/usr/bin/env node
/**
 * Example script demonstrating VBO data exporters
 *
 * This script shows how to:
 * 1. Parse a VBO file
 * 2. Export to CSV format (with time in first column)
 * 3. Export to MoTeC i2 Pro LD binary format
 * 4. Save exported files
 *
 * Usage:
 *   bun run bin/example-exporters.ts
 */

import { VBOParser, VBOExporter, exportToCSV, exportToMotecLD } from '../src/index';
import type { VBOSession } from '../src/types';
import { writeFileSync } from 'fs';
import { join } from 'path';

// Mock VBO data for demonstration
// In real usage, you would read from an actual VBO file
const mockVBOContent = `File created on 15/12/2023 @ 14:30:25

[header]
satellites
time
latitude
longitude
velocity
heading
height
vertical velocity
engine speed
steering angle
throttle pedal
brake pressure front
vehicle speed
gear

[channel units]
(null)
s
deg
deg
kmh
deg
m
m/s
rpm
deg
%
bar
kmh
(null)

[column names]
sats time lat long velocity heading height vvel rpm steer throttle brake speed gear

[laptiming]
Start 0 52.0750,-1.0170,52.0760,-1.0180

[circuit details]
Country UK
Circuit Silverstone GP

[data]
12 0.0 52.0750 -1.0170 145.2 180.0 150.5 0.0 6500 -5.2 85.0 0.0 145.2 5
12 0.1 52.0751 -1.0171 147.8 181.2 150.6 0.1 6750 -4.8 90.0 0.0 147.8 5
12 0.2 52.0752 -1.0172 150.3 182.1 150.7 0.1 7000 -4.2 95.0 0.0 150.3 5
12 0.3 52.0753 -1.0173 152.1 182.8 150.8 0.1 7200 -3.5 98.0 0.0 152.1 5
12 0.4 52.0754 -1.0174 153.5 183.2 150.9 0.1 7350 -2.8 100.0 0.0 153.5 5
12 0.5 52.0755 -1.0175 154.2 183.5 151.0 0.1 7400 -2.0 100.0 0.0 154.2 6
12 0.6 52.0756 -1.0176 154.8 183.7 151.1 0.1 6200 -1.2 100.0 0.0 154.8 6
12 0.7 52.0757 -1.0177 155.0 183.8 151.2 0.1 6400 -0.5 100.0 0.0 155.0 6
12 0.8 52.0758 -1.0178 154.9 183.9 151.3 0.1 6600 0.2 100.0 0.0 154.9 6
12 0.9 52.0759 -1.0179 154.5 184.0 151.4 0.1 6750 0.8 98.0 0.0 154.5 6
12 1.0 52.0760 -1.0180 153.8 184.1 151.5 0.1 6850 1.5 95.0 0.0 153.8 6
12 1.1 52.0761 -1.0181 152.5 184.5 151.6 0.1 6900 2.2 90.0 0.5 152.5 6
12 1.2 52.0762 -1.0182 150.8 185.0 151.7 0.1 6850 3.0 85.0 1.2 150.8 6
12 1.3 52.0763 -1.0183 148.2 185.8 151.8 0.1 6750 3.8 75.0 2.5 148.2 6
12 1.4 52.0764 -1.0184 145.0 186.5 151.9 0.1 6600 4.5 65.0 4.0 145.0 5
12 1.5 52.0765 -1.0185 141.2 187.2 152.0 0.1 6400 5.2 50.0 6.5 141.2 5
12 1.6 52.0766 -1.0186 137.5 188.0 152.1 0.1 6150 6.0 35.0 8.5 137.5 5
12 1.7 52.0767 -1.0187 133.8 189.0 152.2 0.1 5900 6.8 25.0 10.2 133.8 4
12 1.8 52.0768 -1.0188 130.2 190.2 152.3 0.1 5650 7.5 15.0 11.5 130.2 4
12 1.9 52.0769 -1.0189 127.0 191.5 152.4 0.1 5400 8.2 10.0 12.0 127.0 4
12 2.0 52.0770 -1.0190 124.5 192.8 152.5 0.1 5200 8.8 5.0 12.2 124.5 3
12 2.1 52.0771 -1.0191 122.8 194.0 152.6 0.1 5050 9.5 0.0 12.0 122.8 3
12 2.2 52.0772 -1.0192 121.5 195.2 152.7 0.1 4950 10.2 0.0 11.5 121.5 3
12 2.3 52.0773 -1.0193 120.8 196.5 152.8 0.1 4900 10.8 5.0 10.8 120.8 3
12 2.4 52.0774 -1.0194 120.5 197.8 152.9 0.1 4850 11.5 10.0 9.5 120.5 3
12 2.5 52.0775 -1.0195 120.8 199.0 153.0 0.1 4820 12.2 20.0 7.8 120.8 3
12 2.6 52.0776 -1.0196 121.5 200.2 153.1 0.1 4850 12.8 35.0 5.5 121.5 3
12 2.7 52.0777 -1.0197 122.8 201.5 153.2 0.1 4950 13.5 50.0 3.0 122.8 4
12 2.8 52.0778 -1.0198 124.5 202.8 153.3 0.1 5100 14.2 65.0 1.5 124.5 4
12 2.9 52.0779 -1.0199 126.8 204.0 153.4 0.1 5350 14.8 75.0 0.5 126.8 4
12 3.0 52.0780 -1.0200 129.5 205.2 153.5 0.1 5650 15.5 85.0 0.0 129.5 4`;

async function main() {
  console.log('='.repeat(70));
  console.log('VBO Data Exporter Example');
  console.log('='.repeat(70));
  console.log();

  // Step 1: Parse VBO data
  console.log('Step 1: Parsing VBO data...');
  const parser = new VBOParser({ calculateLaps: false });
  let session: VBOSession;

  try {
    session = await parser.parseVBOFile(mockVBOContent);
    console.log(`✓ Successfully parsed VBO file`);
    console.log(`  - Data points: ${session.dataPoints.length}`);
    console.log(`  - Duration: ${session.totalTime.toFixed(2)}s`);
    console.log(`  - Channels: ${session.header.channels.length}`);
    console.log();
  } catch (error) {
    console.error('✗ Failed to parse VBO file:', error);
    return;
  }

  // Step 2: Export to CSV (Standard Format)
  console.log('Step 2: Exporting to CSV format...');
  console.log('-'.repeat(70));

  try {
    // Example 2a: Basic CSV export (all channels)
    const csvBasic = exportToCSV(session, {
      decimalPlaces: 3,
    });

    console.log('Example 2a: Basic CSV export (first 5 lines):');
    console.log(csvBasic.split('\n').slice(0, 5).join('\n'));
    console.log('...');
    console.log();

    // Example 2b: CSV export with selected channels
    const csvCustom = exportToCSV(session, {
      channels: ['time', 'velocity', 'engineSpeed', 'throttlePedal', 'gear'],
      includeUnitsInHeader: true,
      decimalPlaces: 2,
    });

    console.log('Example 2b: CSV with selected channels (first 5 lines):');
    console.log(csvCustom.split('\n').slice(0, 5).join('\n'));
    console.log('...');
    console.log();

    // Example 2c: CSV export with semicolon delimiter (European format)
    const csvSemicolon = exportToCSV(session, {
      channels: ['time', 'velocity', 'engineSpeed'],
      delimiter: ';',
      includeUnitsInHeader: false,
      decimalPlaces: 3,
    });

    console.log('Example 2c: CSV with semicolon delimiter (first 3 lines):');
    console.log(csvSemicolon.split('\n').slice(0, 3).join('\n'));
    console.log('...');
    console.log();

    // Example 2d: CSV export in milliseconds
    const csvMillis = exportToCSV(session, {
      channels: ['time', 'velocity', 'engineSpeed'],
      timeFormat: 'milliseconds',
      decimalPlaces: 1,
    });

    console.log('Example 2d: CSV with time in milliseconds (first 3 lines):');
    console.log(csvMillis.split('\n').slice(0, 3).join('\n'));
    console.log('...');
    console.log();

    // Save CSV file
    const csvPath = join(process.cwd(), 'export-example.csv');
    writeFileSync(csvPath, csvCustom);
    console.log(`✓ Saved CSV export to: ${csvPath}`);
    console.log();
  } catch (error) {
    console.error('✗ CSV export failed:', error);
  }

  // Step 3: Export to MoTeC i2 Pro LD Format
  console.log('Step 3: Exporting to MoTeC i2 Pro LD format...');
  console.log('-'.repeat(70));

  try {
    // Example 3a: Automatic metadata export (no options required!)
    const ldAuto = exportToMotecLD(session);

    console.log('Example 3a: MoTeC LD export with automatic metadata:');
    console.log(`  - File size: ${ldAuto.length} bytes`);
    console.log(`  - Metadata auto-populated from VBO session`);
    console.log(`  - Driver: ${session.header.driverId || '(from VBO)'}`);
    console.log(`  - Vehicle: ${session.header.vehicle || '(from VBO)'}`);
    console.log(`  - Circuit: ${session.circuitInfo.circuit || '(from VBO)'}`);
    console.log(`  - Auto-generated comment with session stats`);
    console.log();

    // Example 3b: Basic LD export with custom metadata
    const ldBasic = exportToMotecLD(session, {
      driverName: 'John Doe',
      vehicleId: 'Example Car #42',
      venue: 'Silverstone GP',
      comment: 'Test session exported from VBO Parser',
      channels: ['time', 'velocity', 'engineSpeed', 'throttlePedal', 'brakePressureFront', 'steeringAngle', 'gear'],
    });

    console.log('Example 3b: MoTeC LD export with custom metadata:');
    console.log(`  - File size: ${ldBasic.length} bytes`);
    console.log(`  - Header size: 1536 bytes`);
    console.log(`  - Channel count: 7`);
    console.log(`  - Data points: ${session.dataPoints.length}`);
    console.log();

    // Verify LD file structure
    const view = new DataView(ldBasic.buffer);
    const marker = view.getUint32(0, true);
    const channelCount = view.getUint16(16, true);

    console.log('  LD File Structure:');
    console.log(`    - Marker: 0x${marker.toString(16).toUpperCase()} (expected: 0x40)`);
    console.log(`    - Channel count: ${channelCount}`);
    console.log();

    // Extract metadata from header
    const decoder = new TextDecoder();
    const headerText = decoder.decode(ldBasic.slice(0, 1536));
    const hasDriver = headerText.includes('John Doe');
    const hasVehicle = headerText.includes('Example Car');
    const hasVenue = headerText.includes('Silverstone');

    console.log('  Metadata verification:');
    console.log(`    - Driver name: ${hasDriver ? '✓ Present' : '✗ Missing'}`);
    console.log(`    - Vehicle ID: ${hasVehicle ? '✓ Present' : '✗ Missing'}`);
    console.log(`    - Venue: ${hasVenue ? '✓ Present' : '✗ Missing'}`);
    console.log();

    // Save LD file
    const ldPath = join(process.cwd(), 'export-example.ld');
    writeFileSync(ldPath, ldBasic);
    console.log(`✓ Saved MoTeC LD export to: ${ldPath}`);
    console.log();

    // Example 3c: Using VBOExporter class directly (automatic metadata)
    console.log('Example 3c: Using VBOExporter class with auto-metadata:');
    const exporter = new VBOExporter(session);

    // Export all default channels with automatic metadata
    const ldFull = exporter.toMotecLD();

    console.log(`  - Full export file size: ${ldFull.length} bytes`);
    console.log(`  - Contains all available channels`);
    console.log(`  - All metadata auto-populated from session`);
    console.log();

  } catch (error) {
    console.error('✗ MoTeC LD export failed:', error);
  }

  // Step 4: Comparison and Best Practices
  console.log('Step 4: Export Format Comparison');
  console.log('-'.repeat(70));
  console.log();
  console.log('CSV Format:');
  console.log('  ✓ Human-readable text format');
  console.log('  ✓ Compatible with Excel, Google Sheets, etc.');
  console.log('  ✓ Time always in first column (MoTeC compatible)');
  console.log('  ✓ Customizable delimiter and precision');
  console.log('  ✓ Smaller file size for simple data');
  console.log('  - Limited metadata support');
  console.log();
  console.log('MoTeC LD Format:');
  console.log('  ✓ Native format for MoTeC i2 Pro analysis software');
  console.log('  ✓ Binary format with efficient storage');
  console.log('  ✓ Rich metadata (driver, vehicle, venue, etc.)');
  console.log('  ✓ Preserves channel units and calibration');
  console.log('  ✓ Professional motorsport standard');
  console.log('  - Requires MoTeC i2 software to view');
  console.log();
  console.log('Best Practices:');
  console.log('  • Use CSV for data analysis in spreadsheets or Python/R');
  console.log('  • Use MoTeC LD for professional telemetry analysis');
  console.log('  • Always include time as first column in CSV');
  console.log('  • Set appropriate decimal places (3 for time, 1-2 for data)');
  console.log('  • Include units in headers for clarity');
  console.log('  • Export only needed channels to reduce file size');
  console.log();

  console.log('='.repeat(70));
  console.log('Example completed successfully!');
  console.log('='.repeat(70));
}

// Run the example
main().catch(console.error);
