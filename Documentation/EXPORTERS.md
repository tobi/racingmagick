# VBO Data Exporters

Comprehensive guide to exporting VBO telemetry data to various formats.

## Table of Contents

- [Overview](#overview)
- [Supported Formats](#supported-formats)
- [CSV Export](#csv-export)
  - [Basic Usage](#csv-basic-usage)
  - [Options](#csv-options)
  - [Examples](#csv-examples)
- [MoTeC i2 Pro LD Format](#motec-ld-export)
  - [Basic Usage](#motec-basic-usage)
  - [Options](#motec-options)
  - [Examples](#motec-examples)
- [API Reference](#api-reference)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Overview

The VBO Parser library includes powerful export functionality to convert parsed VBO telemetry data into standard formats used in motorsport data analysis. The exporter module supports:

1. **CSV Format** - Standard comma-separated values with time always in the first column
2. **MoTeC i2 Pro LD Format** - Binary format compatible with MoTeC i2 data analysis software

Both formats maintain full data integrity and support selective channel export for optimized file sizes.

---

## Supported Formats

### CSV (Comma-Separated Values)

- **File Extension:** `.csv`
- **Type:** Text-based
- **Use Cases:**
  - Data analysis in Excel, Google Sheets, or LibreOffice Calc
  - Import into Python (pandas), R, MATLAB, etc.
  - Quick inspection and validation
  - Sharing data with non-specialized tools
- **Compatibility:** Universal

### MoTeC i2 Pro LD Format

- **File Extension:** `.ld`
- **Type:** Binary
- **Use Cases:**
  - Professional telemetry analysis in MoTeC i2 Pro
  - Motorsport engineering and race strategy
  - Multi-session comparison
  - Advanced data visualization
- **Compatibility:** MoTeC i2/i2 Pro software

---

## CSV Export

### CSV Basic Usage

#### Using convenience function

```typescript
import { parseVBOFile, exportToCSV } from '@vbo-parser/core';

// Parse VBO file
const session = await parseVBOFile(vboFile);

// Export to CSV
const csv = exportToCSV(session);

// Save to file (Node.js)
import { writeFileSync } from 'fs';
writeFileSync('telemetry.csv', csv);

// Download in browser
const blob = new Blob([csv], { type: 'text/csv' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = 'telemetry.csv';
a.click();
```

#### Using VBOExporter class

```typescript
import { VBOParser, VBOExporter } from '@vbo-parser/core';

const parser = new VBOParser();
const session = await parser.parseVBOFile(vboFile);
const exporter = new VBOExporter(session);

const csv = exporter.toCSV({
  channels: ['time', 'velocity', 'engineSpeed'],
  decimalPlaces: 3,
});
```

### CSV Options

```typescript
interface CSVExportOptions {
  // Delimiter between columns (default: ',')
  delimiter?: string;

  // Include header row with channel names (default: true)
  includeHeaders?: boolean;

  // Number of decimal places (default: 3)
  decimalPlaces?: number;

  // Include units in header, e.g., "Speed (km/h)" (default: true)
  includeUnitsInHeader?: boolean;

  // Specific channels to export (default: all channels)
  channels?: (keyof VBODataPoint)[];

  // Export only specific lap (default: all data)
  lapNumber?: number;

  // Time format (default: 'seconds')
  timeFormat?: 'seconds' | 'milliseconds';
}
```

### CSV Examples

#### Example 1: Basic export with all channels

```typescript
const csv = exportToCSV(session);
```

**Output:**
```csv
Time (s),Satellites,Latitude (deg),Longitude (deg),Velocity (km/h),Engine Speed (rpm),...
0.000,12,52.0750,-1.0170,145.200,6500.000,...
0.100,12,52.0751,-1.0171,147.800,6750.000,...
```

#### Example 2: Custom channels with high precision

```typescript
const csv = exportToCSV(session, {
  channels: ['time', 'velocity', 'engineSpeed', 'throttlePedal'],
  decimalPlaces: 5,
  includeUnitsInHeader: true,
});
```

**Output:**
```csv
Time (s),Velocity (km/h),Engine Speed (rpm),Throttle Position (%)
0.00000,145.20000,6500.00000,85.00000
0.10000,147.80000,6750.00000,90.00000
```

#### Example 3: European format (semicolon delimiter)

```typescript
const csv = exportToCSV(session, {
  delimiter: ';',
  channels: ['time', 'velocity', 'engineSpeed'],
  includeUnitsInHeader: false,
});
```

**Output:**
```csv
Time;Velocity;Engine Speed
0.000;145.200;6500.000
0.100;147.800;6750.000
```

#### Example 4: Export single lap

```typescript
const csv = exportToCSV(session, {
  lapNumber: 5,
  channels: ['time', 'velocity', 'engineSpeed'],
});
```

#### Example 5: Time in milliseconds

```typescript
const csv = exportToCSV(session, {
  timeFormat: 'milliseconds',
  decimalPlaces: 1,
});
```

**Output:**
```csv
Time,Velocity,Engine Speed,...
0.0,145.2,6500.0,...
100.0,147.8,6750.0,...
200.0,150.3,7000.0,...
```

#### Example 6: No headers (data only)

```typescript
const csv = exportToCSV(session, {
  includeHeaders: false,
  channels: ['time', 'velocity', 'engineSpeed'],
});
```

**Output:**
```csv
0.000,145.200,6500.000
0.100,147.800,6750.000
0.200,150.300,7000.000
```

---

## MoTeC LD Export

### MoTeC Basic Usage

#### Using convenience function

```typescript
import { parseVBOFile, exportToMotecLD } from '@vbo-parser/core';

// Parse VBO file
const session = await parseVBOFile(vboFile);

// Export to MoTeC LD format
const ldData = exportToMotecLD(session, {
  driverName: 'John Doe',
  vehicleId: 'Car #42',
  venue: 'Silverstone GP',
});

// Save to file (Node.js)
import { writeFileSync } from 'fs';
writeFileSync('telemetry.ld', ldData);

// Download in browser
const blob = new Blob([ldData], { type: 'application/octet-stream' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = 'telemetry.ld';
a.click();
```

#### Using VBOExporter class

```typescript
import { VBOParser, VBOExporter } from '@vbo-parser/core';

const parser = new VBOParser();
const session = await parser.parseVBOFile(vboFile);
const exporter = new VBOExporter(session);

const ldData = exporter.toMotecLD({
  driverName: 'John Doe',
  vehicleId: 'Car #42',
  venue: 'Silverstone GP',
  comment: 'Qualifying session',
  channels: ['time', 'velocity', 'engineSpeed', 'throttlePedal', 'brakePressureFront'],
});
```

### MoTeC Options

```typescript
interface MotecLDExportOptions {
  // Driver name (max 64 characters)
  // Default: Uses session.header.driverId if available, otherwise empty
  driverName?: string;

  // Vehicle ID (max 64 characters)
  // Default: Uses session.header.vehicle if available, otherwise empty
  vehicleId?: string;

  // Venue/track name (max 64 characters)
  // Default: Uses session.circuitInfo (circuit, country) if available, otherwise empty
  venue?: string;

  // Short comment (max 64 characters)
  // Default: Auto-generated from session data (lap count, duration, etc.)
  comment?: string;

  // Device serial number (default: 'VBO-PARSER')
  serialNumber?: string;

  // Device type identifier (default: 'VBO')
  deviceType?: string;

  // Specific channels to export (default: all channels)
  channels?: (keyof VBODataPoint)[];

  // Export only specific lap (default: all data)
  lapNumber?: number;
}
```

**Automatic Metadata Population:**

When options are not explicitly provided, the exporter automatically extracts information from the VBO session:

- **driverName**: Pulled from `session.header.driverId`
- **vehicleId**: Pulled from `session.header.vehicle`
- **venue**: Built from `session.circuitInfo.circuit` and `session.circuitInfo.country`
- **comment**: Auto-generated with lap count, duration, and export source

This means you can call `exportToMotecLD(session)` with no options and get a fully populated LD file with all available metadata!

### MoTeC Examples

#### Example 1: Automatic metadata from VBO session (no options required!)

```typescript
// If your VBO file has driver, vehicle, and circuit info, just export!
const ldData = exportToMotecLD(session);
// Automatically includes:
// - Driver name from VBO header
// - Vehicle from VBO header
// - Circuit/country from VBO circuit info
// - Auto-generated comment with lap count and duration

writeFileSync('session.ld', ldData);
```

#### Example 2: Basic export with custom metadata

```typescript
// Override automatic metadata with your own
const ldData = exportToMotecLD(session, {
  driverName: 'John Doe',
  vehicleId: 'Porsche 911 GT3 #42',
  venue: 'Silverstone GP',
  comment: 'Race session - dry conditions',
});

writeFileSync('session.ld', ldData);
```

#### Example 3: Export essential channels only

```typescript
const ldData = exportToMotecLD(session, {
  driverName: 'Jane Smith',
  vehicleId: 'BMW M4 GT4',
  venue: 'Spa-Francorchamps',
  channels: [
    'time',
    'velocity',
    'engineSpeed',
    'throttlePedal',
    'brakePressureFront',
    'steeringAngle',
    'gear',
    'latitude',
    'longitude',
  ],
});
```

#### Example 4: Export fastest lap with auto-generated metadata

```typescript
import { findFastestLap } from '@vbo-parser/core';

const fastestLap = findFastestLap(session.laps);

if (fastestLap) {
  // Comment will auto-generate as "Lap X: Y.YYYs - VBO Export"
  const ldData = exportToMotecLD(session, {
    lapNumber: fastestLap.lapNumber,
  });

  writeFileSync(`fastest-lap-${fastestLap.lapNumber}.ld`, ldData);
}
```

#### Example 5: Batch export all laps (using automatic metadata)

```typescript
for (const lap of session.laps) {
  if (lap.isValid && lap.label === 'timed-lap') {
    // All metadata auto-populated from session, comment auto-generated
    const ldData = exportToMotecLD(session, {
      lapNumber: lap.lapNumber,
    });

    writeFileSync(`lap-${lap.lapNumber}.ld`, ldData);
  }
}
```

---

## API Reference

### VBOExporter Class

```typescript
class VBOExporter {
  constructor(session: VBOSession);

  /**
   * Export to CSV format with time always in first column
   */
  toCSV(options?: CSVExportOptions): string;

  /**
   * Export to MoTeC i2 Pro LD binary format
   */
  toMotecLD(options?: MotecLDExportOptions): Uint8Array;
}
```

### Convenience Functions

```typescript
/**
 * Export VBO session to CSV
 */
function exportToCSV(
  session: VBOSession,
  options?: CSVExportOptions
): string;

/**
 * Export VBO session to MoTeC LD format
 */
function exportToMotecLD(
  session: VBOSession,
  options?: MotecLDExportOptions
): Uint8Array;
```

### Available Channels

All VBODataPoint properties can be exported:

```typescript
// GPS/Location
'time' | 'satellites' | 'latitude' | 'longitude' | 'velocity' | 'heading' |
'height' | 'verticalVelocity' |

// Vehicle Dynamics
'vehicleSpeed' | 'steeringAngle' | 'gear' | 'comboAcc' | 'comboG' |

// Engine
'engineSpeed' | 'throttlePedal' |

// Braking
'brakePressureFront' |

// Traction Control
'tcSlip' | 'tcGain' | 'tcActive' |

// Environmental
'ambientTemperature' | 'fuelProbe' | 'carOnJack' |

// Additional
'lapNumber' | 'solutionType' | 'aviFileIndex' | 'aviSyncTime' |
'ppsMap' | 'epsMap' | 'engMap' | 'driverId' | 'headrest' | 'lapGainLoss'
```

---

## Best Practices

### CSV Export Best Practices

1. **Time Column**
   - Always keep time as the first column (automatic)
   - Use seconds format for MoTeC compatibility
   - Use 3 decimal places for millisecond precision

   ```typescript
   const csv = exportToCSV(session, {
     timeFormat: 'seconds',
     decimalPlaces: 3,
   });
   ```

2. **Channel Selection**
   - Export only needed channels to reduce file size
   - Group related channels (e.g., all engine data, all GPS data)

   ```typescript
   const engineData = exportToCSV(session, {
     channels: ['time', 'engineSpeed', 'throttlePedal', 'gear'],
   });
   ```

3. **Precision**
   - Use 3 decimal places for time
   - Use 1-2 decimal places for speed/RPM
   - Use 3-4 decimal places for GPS coordinates

   ```typescript
   // Not configurable per channel, use post-processing if needed
   const csv = exportToCSV(session, {
     decimalPlaces: 3, // Global precision
   });
   ```

4. **Headers**
   - Always include units for clarity
   - Use headers unless importing to software that doesn't support them

5. **Delimiters**
   - Use comma (`,`) for US/UK locale
   - Use semicolon (`;`) for European locale (Excel compatibility)

### MoTeC LD Export Best Practices

1. **Metadata**
   - Always include driver name, vehicle, and venue
   - Keep metadata strings under 64 characters
   - Use descriptive comments

   ```typescript
   const ldData = exportToMotecLD(session, {
     driverName: 'J. Doe', // Keep concise
     vehicleId: 'Car #42',
     venue: 'Silverstone', // Short venue name
     comment: 'Q1 - Dry - New tires',
   });
   ```

2. **Channel Selection**
   - Include GPS channels (lat/lon) for track mapping
   - Include time-critical channels (speed, RPM, throttle, brake, steering)
   - Exclude unnecessary channels for smaller files

3. **File Organization**
   - Export each lap separately for detailed analysis
   - Export full sessions for overview analysis
   - Use descriptive filenames

   ```typescript
   const filename = `${driverName}_${venue}_lap${lapNumber}.ld`;
   ```

4. **Validation**
   - Verify file size is reasonable (> 1536 bytes minimum)
   - Check marker byte (0x40) after export
   - Validate in MoTeC i2 before sharing

   ```typescript
   const ldData = exportToMotecLD(session, options);
   const view = new DataView(ldData.buffer);
   const marker = view.getUint32(0, true);
   console.assert(marker === 0x40, 'Invalid LD file marker');
   ```

### Performance Optimization

1. **Large Files**
   - Export laps individually instead of entire session
   - Limit channels to those actually needed
   - Consider CSV for very large datasets (faster parsing)

2. **Batch Exports**
   - Reuse VBOExporter instance for multiple exports

   ```typescript
   const exporter = new VBOExporter(session);

   for (const lap of session.laps) {
     const ldData = exporter.toMotecLD({ lapNumber: lap.lapNumber });
     writeFileSync(`lap-${lap.lapNumber}.ld`, ldData);
   }
   ```

3. **Memory Management**
   - Release binary data after writing files
   - Process sessions one at a time for batch operations

---

## Troubleshooting

### Common Issues

#### CSV Export Issues

**Problem:** CSV file has incorrect column order
- **Solution:** Time is always first automatically. Specify other channels in desired order:

```typescript
const csv = exportToCSV(session, {
  channels: ['time', 'velocity', 'engineSpeed', 'throttlePedal'],
});
```

**Problem:** Decimal separator issues in Excel (European locale)
- **Solution:** Use semicolon delimiter:

```typescript
const csv = exportToCSV(session, {
  delimiter: ';',
});
```

**Problem:** Missing data in CSV
- **Solution:** Check that channels exist in source data:

```typescript
// Check available channels
console.log(session.header.channels);

// Export only available channels
const csv = exportToCSV(session, {
  channels: ['time', 'velocity'], // Use only channels you know exist
});
```

#### MoTeC LD Export Issues

**Problem:** MoTeC i2 won't open the LD file
- **Solution:** Verify file structure and marker:

```typescript
const ldData = exportToMotecLD(session, options);
const view = new DataView(ldData.buffer);
const marker = view.getUint32(0, true);

if (marker !== 0x40) {
  console.error('Invalid LD file structure');
}
```

**Problem:** Metadata not showing in MoTeC i2
- **Solution:** Ensure strings are not too long (64 char limit):

```typescript
const ldData = exportToMotecLD(session, {
  driverName: 'Very Long Driver Name That Exceeds Limit'.substring(0, 63),
  // Truncate to 63 chars (plus null terminator = 64)
});
```

**Problem:** File size too large
- **Solution:** Export only essential channels:

```typescript
const ldData = exportToMotecLD(session, {
  channels: [
    'time', 'velocity', 'engineSpeed',
    'throttlePedal', 'brakePressureFront', 'steeringAngle', 'gear'
  ],
});
```

**Problem:** Channel data appears incorrect in MoTeC i2
- **Solution:** This is rare. Verify source VBO data is correct:

```typescript
// Check source data
console.log(session.dataPoints[0]);

// Try CSV export first to verify data
const csv = exportToCSV(session, { channels: ['time', 'velocity'] });
console.log(csv.split('\n').slice(0, 5).join('\n'));
```

### Error Messages

**"No data points available for export"**
- The session has no parsed data
- Check VBO file parsing succeeded
- Verify session.dataPoints is not empty

**"Lap X not found in session"**
- The specified lap number doesn't exist
- Check available laps: `console.log(session.laps.map(l => l.lapNumber))`
- Use valid lap number or omit lapNumber option

### Performance Issues

**CSV export is slow**
- Large dataset (100,000+ points)
- Reduce decimal places
- Export fewer channels
- Consider exporting laps individually

**LD export is slow**
- Normal for large files (binary encoding is intensive)
- Export fewer channels
- Export laps individually
- Ensure adequate memory

---

## MoTeC i2 Pro Format Details

### Binary Format Structure

The LD format consists of three main sections:

1. **Header (1536 bytes)**
   - File marker (0x40)
   - Pointers to metadata and data
   - Channel count
   - Date/time
   - Metadata (driver, vehicle, venue, comment)
   - Device information

2. **Channel Metadata (128 bytes per channel)**
   - Linked list structure
   - Data type and encoding
   - Sampling frequency
   - Calibration parameters (shift, multiplier, scale)
   - Channel name, short name, and unit

3. **Channel Data (variable size)**
   - Binary encoded data for each channel
   - Data types: float32, int16, int32
   - Optimized storage based on data characteristics

### Data Type Selection

The exporter automatically selects optimal data types:

- **int16**: Discrete values (gear, satellites, boolean flags)
- **int32**: Large integers that don't fit in int16
- **float32**: Continuous values (speed, temperature, angles)

### Calibration

Channel values are calibrated using the formula:

```
displayed_value = (raw_value / scale × 10^(-decimals) + shift) × multiplier
```

For VBO exports, calibration parameters are set to preserve original values:
- shift = 0
- multiplier = 1
- scale = 1 (or 10 for RPM)
- decimals = 3 (or 0 for integers)

---

## Further Reading

- [VBO Format Specification](./VBO_FORMAT.md)
- [Usage Guide](./USAGE.md)
- [API Reference](./API.md)
- [MoTeC i2 Pro Documentation](https://www.motec.com.au/i2/i2support/)

---

## Support

For issues or questions:
- GitHub Issues: [vbo-parser/core/issues](https://github.com/vbo-parser/core/issues)
- Example Scripts: See `/bin/example-exporters.ts`
- Unit Tests: See `/src/exporters.test.ts`
