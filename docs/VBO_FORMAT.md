# VBO File Format Specification

## Overview

VBO files are text-based telemetry data files produced by Racelogic's VBOX data logging systems. They contain timestamped sensor data from various vehicle systems including GPS, engine parameters, and vehicle dynamics measurements.

**Important**: VBO files are highly variable in structure. Almost all sections are optional except for the core data sections. The parser must be flexible to handle different file variations.

## File Structure

VBO files use a section-based format with square bracket delimited sections `[section name]`. The basic structure is:

```
File created on DD/MM/YYYY at HH:MM:SS

[header]
channel1
channel2
...

[channel units]
unit1
unit2
...

[column names]
col1 col2 col3 ...

[data]
value1 value2 value3 ...
value1 value2 value3 ...
...

[optional sections]
...
```

## Core Sections

### File Header (Optional)
The file may start with a creation timestamp:
```
File created on 15/12/2023 at 14:30:25
```

**Supported date formats:**
- `DD/MM/YYYY at HH:MM:SS`
- `DD/MM/YYYY`

**Note**: The timestamp uses "at" not "@" as the separator.

### `[header]` Section (Required)
Contains the human-readable channel names, one per line:
```
[header]
satellites
time
latitude
longitude
velocity
heading
```

### `[channel units]` Section (Optional)
Contains units for channels that don't have units in their names:
```
[channel units]
(null)
s
deg
deg
kmh
deg
```

**Important**: Many VBOX channels include units in their names (e.g., "velocity kmh", "vertical velocity m/s"). The `[channel units]` section is primarily used for external/analog input channels. Built-in GPS channels often have units embedded in the channel name itself.

**Note**: Units may be `(null)` or empty for dimensionless values or when units are included in channel names.

### `[column names]` Section (Optional)
Contains space-separated machine-readable column names (abbreviated versions of header names):
```
[column names]
sats time lat long velocity heading
```

**Important**: 
- If this section is missing, the parser uses the `[header]` channel names as column names
- Column names are typically abbreviated (e.g., "vertical velocity kmh" → "vertvel")
- They may remove spaces, units, and use lowercase

### `[data]` Section (Required)
Contains the actual telemetry data, one row per sample:
```
[data]
8 143025.500 +03119.09973 -00245.67890 85.2 180.5
7 143026.000 +03119.10973 -00245.68890 82.1 175.2
```

## Optional Sections

### `[comments]` Section
Contains device and logging metadata:
```
[comments]
Copyright, Racelogic Ltd
VBOX 3i firmware version 1.00
GPS Type, u-blox LEA-5H
Serial Number, VB3i123456
Logging Rate, 100 Hz
Software Version, VBOX Tools 2.5.1
```

**Purpose**: Provides metadata about the logging device, firmware versions, GPS type, serial numbers, logging rates, and software versions.

### `[laptiming]` Section
Contains timing line definitions for lap detection:
```
[laptiming]
Start -1042.214520 +2921.328310 -1042.214520 +2921.301330 Start/Finish
Split -1042.281770 +2921.360280 -1042.281770 +2921.333300 Split 1
```

**Format**: Each line contains:
- Keyword: `Start` or `Split`
- Two coordinate pairs (longitude latitude longitude latitude)
- Optional description at the end

**Note**: No special separators like "¬" are used - just space-separated values.

### `[avi]` Section
Links video files to the VBO data:
```
[avi]
session_
MP4
```

**Purpose**: 
- First line: video file prefix
- Second line: file extension
- Combined with aviFileIndex (e.g., 2) creates filename: `session_0002.MP4`
- aviSyncTime field provides timestamp within the video

### `[circuit details]` Section (Non-standard)
Contains circuit information (not present in all VBO files):
```
[circuit details]
country United States
circuit Laguna Seca
```

**Note**: This section may appear when track metadata is available from track databases or user input. Not a standard Racelogic section.

### `[session data]` Section (Third-party)
Used by some applications like RaceChrono:
```
[session data]
session Test Session
driver John Doe
vehicle BMW M3
notes Practice run
```

## Data Types and Post-Processing

### Time Format
Times are stored in `HHMMSS.ff` format (UTC time-of-day with hundredths of seconds by default):
- `162235.40` = 16:22:35.40 UTC
- `143025.500` = 14:30:25.500 UTC (if millisecond precision)

**Important**: 
- Time represents UTC time-of-day (since midnight), not elapsed session time
- Default resolution is 0.01s (hundredths), but can be higher
- Parser converts to seconds since midnight: `16*3600 + 22*60 + 35.4 = 58355.4`

**Post-processing**: The parser may normalize timestamps to be relative to session start (subtracts minimum time) for convenience, but this is a parser implementation choice, not inherent to the file format.

### Coordinate Systems
The parser automatically detects and converts between coordinate formats:

#### 1. Decimal Degrees (Less Common)
- **Format**: `±DD.DDDDDD`
- **Example**: `45.123456, -73.654321`
- **Range**: Latitude ±90°, Longitude ±180°
- **Usage**: May appear in post-converted files or from non-VBOX sources
- **Post-processing**: None required

#### 2. NMEA Format (DDMM.MMMMM) - Most Common
- **Format**: `DDMM.MMMMM` (degrees + decimal minutes)
- **Example**: `+03119.09973` = 03°19.09973' N = 51.9833° N
- **Usage**: Default format for most VBOX devices
- **Post-processing**: 
  ```
  degrees = floor(abs(value) / 100)
  minutes = abs(value) % 100
  decimal = degrees + (minutes / 60)
  // Preserve original sign
  result = value < 0 ? -decimal : decimal
  ```

#### 3. VBOX Minutes Format
- **Format**: Total minutes as decimal
- **Example**: `4507.2074` = 45.120123°
- **Post-processing**: `decimal_degrees = total_minutes / 60`

#### 4. Local Coordinates
- **Format**: Large values indicating local Cartesian coordinates (typically in meters)
- **Detection**: Values that don't fit GPS coordinate patterns and are very large
- **Caution**: Simple thresholds like ">1000" can misidentify longitudes in minutes format (e.g., 117°W = 11700.x minutes)
- **Post-processing**: No conversion applied - used as-is for local coordinate systems

### Numeric Values
- **Null values**: Represented as `(null)`, `null`, or empty strings
- **Post-processing**: Converted to `null` or default value (0)
- **Invalid numbers**: Gracefully handled, converted to default values

### Video File Association
Video files follow the naming pattern defined in the `[avi]` section:
- VBO file: `session_RD.vbo`
- `[avi]` section contains: `session_` and `MP4`
- Video files: `session_0001.MP4`, `session_0002.MP4`, etc.

The `aviFileIndex` field in data points indicates which video file (1, 2, 3...), and `aviSyncTime` (or `aviTime`) provides the timestamp within that video.

**Note**: Some older exports used `aviTime` instead of `aviSyncTime`, but `aviSyncTime` is preferred for compatibility with Circuit Tools.

## Channel Mappings

The parser supports flexible column name mapping. Common variations:

| VBO Column | Standard Name | Variations |
|------------|---------------|------------|
| `sats` | satellites | `satellites` |
| `time` | time | - |
| `lat` | latitude | `latitude` |
| `long` | longitude | `longitude` |
| `velocity` | velocity | `velocity kmh` |
| `vertvel` | verticalVelocity | `vertical velocity m/s`, `vertical velocity kmh` |
| `Tsample` | samplePeriod | `sampleperiod` |
| `solution_type` | solutionType | `solution type` |
| `avifileindex` | aviFileIndex | - |
| `avisynctime` | aviSyncTime | - |

## Complete Channel List

Based on the parser's default mappings, VBO files may contain these channels:

**Important**: Not all channels appear in every file - they depend on hardware configuration, connected sensors, and input modules. The following is a comprehensive list of supported channels.

### GPS/Navigation
- `satellites` - Number of GPS satellites
- `time` - Timestamp (HHMMSS.mmm format)
- `latitude` - GPS latitude
- `longitude` - GPS longitude
- `velocity` - GPS velocity (km/h)
- `heading` - GPS heading (degrees)
- `height` - GPS altitude
- `verticalVelocity` - Vertical velocity (historically km/h in older VBOX devices, m/s in newer ones)
- `samplePeriod` - Sample period
- `solutionType` - GPS fix status/solution quality

### Video Synchronization
- `aviFileIndex` - Video file index (1, 2, 3...)
- `aviSyncTime` - Timestamp in video file

### Vehicle Dynamics
- `comboAcc` - Combined acceleration
- `comboG` - Combined G-force
- `steeringAngle` - Steering wheel angle
- `vehicleSpeed` - Vehicle speed (may differ from GPS velocity)
- `gear` - Current gear

### Engine/Powertrain
- `engineSpeed` - Engine RPM
- `throttlePedal` - Throttle pedal position (%)

### Braking
- `brakePressureFront` - Front brake pressure

### Traction Control
- `tcSlip` - TC slip value
- `tcGain` - TC gain
- `tcActive` - TC active status

### System Maps
- `ppsMap` - PPS map value
- `epsMap` - EPS map value  
- `engMap` - Engine map value

### Environmental
- `ambientTemperature` - Ambient temperature
- `carOnJack` - Car on jack status
- `headrest` - Headrest status
- `fuelProbe` - Fuel probe reading

### Session Data
- `driverId` - Driver identifier (numeric)
- `lapNumber` - Current lap number
- `lapGainLoss` - Lap time gain/loss

## File Variations

### Minimal VBO File
```
[header]
time
latitude
longitude

[data]
143025.500 45.123456 -73.654321
143026.000 45.124456 -73.655321
```

### Complete VBO File
```
File created on 31/07/2006 at 09:55:20

[header]
satellites
time
latitude
longitude
velocity
heading
height
engineSpeed
gear

[channel units]
(null)
s
deg
deg
kmh
deg
m
rpm
(null)

[column names]
sats time lat long velocity heading height Engine_Speed Gear

[comments]
Copyright, Racelogic Ltd
VBOX 3i firmware version 1.00
GPS Type, u-blox LEA-5H
Serial Number, VB3i123456
Logging Rate, 100 Hz

[data]
8 143025.500 4512.3456 -7365.4321 85.2 180.5 100.5 3000 3
7 143026.000 4512.4456 -7365.5321 82.1 175.2 100.3 2950 3

[laptiming]
Start -1042.214520 +2921.328310 -1042.214520 +2921.301330 Start/Finish
Split -1042.281770 +2921.360280 -1042.281770 +2921.333300 Split 1

[avi]
session_
MP4

[circuit details]
country United States
circuit Test Circuit
```

## Parser Implementation Notes

1. **Section Detection**: Parser looks for lines starting with `[` and ending with `]`
2. **Flexible Parsing**: Missing sections are handled gracefully
3. **Column Mapping**: Uses both default mappings and custom user mappings
4. **Coordinate Detection**: Automatically detects coordinate system type
5. **Error Handling**: Invalid data points are skipped, not fatal
6. **Memory Efficiency**: Supports limiting data points for large files
7. **Video Integration**: Automatically detects associated video files

## Usage with Parser

```typescript
import { VBOParser } from '@vbo-parser/core';

const parser = new VBOParser({
  customColumnMappings: {
    'custom_speed': 'velocity',
    'my_rpm': 'engineSpeed'
  }
});

const session = await parser.parseVBOFile(vboContent);

// Access video for a data point
const videoInfo = VBOParser.getVideoForDataPoint(session, session.dataPoints[0]);
// Returns: { file: '/videos/filename_0001.mp4', timestamp: 15.25 } or null
```

This flexible format allows VBO files to contain anywhere from basic GPS data to comprehensive vehicle telemetry, with the parser adapting to the available data.