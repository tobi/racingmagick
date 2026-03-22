# Pi/Cosworth .pds Binary File Format Specification

Reverse-engineered from Pi System / Cosworth telemetry files used in IMSA prototypes (Oreca 07 LMP2). Sufficient to implement a complete parser.

## Overview

A `.pds` file is a single self-contained binary file (no companion files needed). It stores a directory of data sections, channel definitions, chunk-based sample data, and lap beacon channels — all in one blob.

| Aspect | Detail |
|--------|--------|
| File extension | `.pds` |
| Byte order | **Little-endian** |
| String encoding | **UTF-16LE** (null-terminated) |
| Typical size | 50–200 MB per session |
| Origin | Pi Research / Cosworth data loggers (Pi Sigma, Pi Delta, Pi Omega, Cosworth ICD) |

### Filename Convention

Pi/Cosworth files follow a structured naming pattern:

```
YYMMDDHHMMSS_SERIES_TEAM_TRACK_SESSION_Run_DRIVER_CAR.pds
```

Example: `260224000716_26IMSA02_T02_SEB_CT3_Run001_MB_MQ12Di_LMP2 #443.pds`

| Token | Meaning |
|-------|---------|
| `260224000716` | Date/time: 2026-02-24 00:07:16 |
| `26IMSA02` | Series/round (2026 IMSA Round 2) |
| `T02` | Team number |
| `SEB` | Track code (Sebring) |
| `CT3` | Session type (e.g. Competitive Test 3) |
| `Run001` | Run number |
| `MB` | Driver initials |
| `MQ12Di_LMP2 #443` | Car identifier |

The date/time can be extracted via regex: `^(\d{2})(\d{2})(\d{2})(\d{6})` → YY, MM, DD, HHMMSS.

## File Structure

```
┌──────────────────────────┐  0x00
│  File Header             │
│  (directory at 0x80)     │
├──────────────────────────┤  varies
│  Channel Definitions     │
│  (fixed-size records)    │
├──────────────────────────┤  varies
│  Chunk Index             │
│  (fixed-size records)    │
├──────────────────────────┤  varies
│  Raw Sample Data         │
│  (referenced by chunks)  │
└──────────────────────────┘
```

## Directory (offset 0x80)

The directory is an array of section descriptors starting at offset `0x80`. The count is stored at `0x88`.

### Directory Header

| Offset | Size | Type | Field |
|--------|------|------|-------|
| 0x88 | 4 | uint32 | `entry_count` — number of directory entries (max 64) |

### Directory Entry (32 bytes each, starting at 0x80)

| Offset | Size | Type | Field | Notes |
|--------|------|------|-------|-------|
| +0x00 | 4 | uint32 | `offset_lo` | Low 32 bits of byte offset |
| +0x04 | 4 | uint32 | `offset_hi` | High 32 bits (for files >4 GB) |
| +0x08 | 4 | uint32 | `count` | Number of records in section |
| +0x10 | 4 | uint32 | `class_a` | Section class identifier A |
| +0x14 | 4 | uint32 | `class_b` | Section class identifier B |
| +0x18 | 4 | uint32 | `next_count` | Record count for the *next* section |

Full offset = `offset_lo | (offset_hi << 32)`.

### Finding the Layout

Do **not** hard-code a single layout. In practice there are multiple PDS variants. The reliable path is:

1. Read the directory at `0x80`
2. Examine each run of three consecutive entries
3. Treat `entry[i]` as a **candidate definitions block**, `entry[i+1]` as a **candidate chunk block**, and `entry[i+2]` as the **candidate end boundary**
4. Validate the candidate by checking that:
   - a plausible sequence of definition records can be read before the chunk block
   - the chunk block contains plausible records (sample count > 0, sample period > 0, data pointers in bounds)
5. Pick the first candidate that validates well

```
entry[i]   → candidate channel definitions
entry[i+1] → candidate chunk index
entry[i+2] → candidate next section / end boundary
```

### Known Layout Variants

#### Variant A — legacy / large-definition layout

This is the original IMSA-style layout:

- definitions entry usually has `class_a == 1 && class_b == 1`
- definitions count is often **large** (`>500`)
- chunk count typically comes from `entry[i].next_count`
- chunk records use a duplicated channel id field (`channel_id == channel_id_2`)
- chunk record size is inferred from the section span

#### Variant B — compact export layout (newer CT exports)

Observed in newer export files like `Export_MB_CT5_SebringTest2026.pds`:

- definitions entry still has `class_a == 1 && class_b == 1`
- definitions count is **small** (e.g. `31`)
- chunk count comes from the **chunk entry's `count`** (e.g. `407`)
- chunk section is exactly `chunk_count × 64` bytes
- chunk records are fixed **64-byte** records
- there is **no duplicate channel id field** at `+0x08`

So the parser should not assume “big definitions section == true PDS”; it should validate structure instead.

## Channel Definitions

Fixed-size records starting at `defsOffset`. Each record describes one data channel.

### Record Size Detection

Scan forward from `defsOffset` looking for the **marker value** `0x7c72` (uint64). The first occurrence is the true start. The gap between consecutive markers gives the record size (typically **304 bytes**, but varies by logger firmware).

### Channel Definition Record

| Offset | Size | Type | Field | Notes |
|--------|------|------|-------|-------|
| +0x00 | 8 | uint64 | `marker` | Must be `0x7c72`. Skip if different. |
| +0x08 | 4 | uint32 | `channel_id` | Unique channel identifier |
| +0x10 | 112 | utf16le | `name` | Channel name (56 UTF-16 chars, null-terminated) |
| +0x98 | 32 | utf16le | `unit` | Unit string (16 UTF-16 chars) |
| +0xD8 | 4 | uint32 | `type_code` | Data type (see below) |

### Data Type Codes

| Code | Encoding | Byte Size |
|------|----------|-----------|
| 1 | uint8 | 1 |
| 3 | uint16 (little-endian) | 2 |
| 4 | int32 (signed, little-endian) | 4 |
| 5 | uint32 (little-endian) | 4 |
| 6 | IEEE 754 float32 (little-endian) | 4 |
| other | float32 (default fallback) | 4 |

**No conversion formula** — unlike MoTeC `.ld`, PDS channel values are stored in physical units directly. Float channels read as-is; integer channels read as raw integers (the unit string implies the scaling).

## Chunk Index

Fixed-size records starting at `chunkOffset`. Each chunk points to a contiguous block of sample data for one channel.

### Chunk Record Size Detection

`chunk_record_size = (nextOffset - chunkOffset) / chunk_count`

### Validating Chunk Start

The chunk offset from the directory may not be perfectly aligned. Scan forward (up to 4096 bytes) looking for the first valid chunk: `channelId > 0 && channelId == channelId2 && sampleCount > 0`.

### Chunk Record

| Offset | Size | Type | Field | Notes |
|--------|------|------|-------|-------|
| +0x00 | 4 | uint32 | `order` | Sequence number (for multi-chunk channels) |
| +0x04 | 4 | uint32 | `channel_id` | Must match a channel definition |
| +0x08 | 4 | uint32 | `channel_id_2` | Duplicate — must equal `channel_id` (validation) |
| +0x18 | 4 | uint32 | `sample_period_ticks` | Time between samples (in ticks) |
| +0x1C | 4 | uint32 | `sample_count` | Number of samples in this chunk |
| +0x38 | 4 | uint32 | `data_ptr` | Byte offset to raw sample data |

### Ticks → Frequency

The Pi system uses a 10 MHz tick clock:

```
ticks_per_second = 10_000_000
sample_rate_hz = round(ticks_per_second / sample_period_ticks)
```

Example: `sample_period_ticks = 50000` → `10_000_000 / 50000 = 200 Hz`

### Multi-Chunk Channels

A channel may have multiple chunks (e.g., split across recording segments). Sort chunks by `(order, data_ptr)` ascending, then concatenate their decoded samples.

## Sample Data Decoding

Read `sample_count` values from `data_ptr` using the channel's `type_code`:

```
type 1:  read sample_count × uint8
type 3:  read sample_count × uint16 (little-endian)
type 4:  read sample_count × int32  (little-endian, signed)
type 5:  read sample_count × uint32 (little-endian)
type 6:  read sample_count × float32 (IEEE 754, little-endian)
default: read as float32
```

**Bounds checking**: clamp `sample_count` to `(data.count - data_ptr) / byte_size`.

## Lap Detection

PDS files have no separate lap file (unlike MoTeC's `.ldx`). Lap boundaries are inferred from special telemetry channels, tried in priority order:

### 1. Lap Beacon (`lap_beacon`, `lap_beacon_trig`, `laptrigger`)

A binary pulse channel. Rising edge = lap boundary.

```
for each sample:
    if value != 0 and previous was 0:
        split_time = sample_index / frequency
```

### 2. Lap Time Channel (`lap time`)

A running timer that resets at each lap boundary.

```
for each sample:
    if previous_value - current_value > 5.0:
        split_time = sample_index / frequency
```

(Large drop = timer reset = new lap started.)

### 3. Lap Number Channel (`lap number`)

An incrementing integer.

```
for each sample:
    if current_value != previous_value:
        split_time = sample_index / frequency
```

### 4. Lap Distance Channel (`lap distance corrected`, `lap distance`)

Distance resets to zero at each lap boundary.

```
for each sample:
    if previous_value - current_value > 300:
        split_time = sample_index / frequency
```

(Drop of >300m = distance reset = new lap.)

### Building Laps from Splits

1. Collect all split times, deduplicate, sort ascending
2. Each consecutive pair with gap > 10s forms a lap
3. Compute median lap duration; use it to decide whether to include head/tail partial laps
4. If a `previous lap time` channel exists, use its value at each lap boundary for precise timing (overrides the computed duration when within 30s of the split-derived time)

### Previous Lap Time Refinement

The `previous lap time` channel reports the logger's own measurement of the just-completed lap. Sample it at each lap's `endTime`:

```
for each lap:
    prev_lap_sec = sample(previous_lap_time, at: lap.endTime)
    if |prev_lap_sec - computed_duration| < 30:
        lap.timeMs = prev_lap_sec * 1000
```

## Session Metadata

### From Filename

There is no embedded header with driver/track/date metadata. Extract from the filename:

| Token position | Meaning | Extraction |
|----------------|---------|------------|
| Leading digits | Date/time | `YYMMDDHHMMSS` |
| Track code | Venue | Lookup table (SEB→Sebring, DAY→Daytona, etc.) |
| Driver initials | Driver | Two-letter code before car identifier |
| Car identifier | Vehicle | Token containing "LMP", "GTD", "MQ", etc. |

### Global Time Channel

Some PDS files contain a `FIA_GpsTimeUTC` or `Global Time` channel with Unix timestamps (seconds since epoch). This enables:

- Absolute session start time
- Video sync by matching against video file creation time

```
session_start_unix = global_time[0]
unix_at_session_time(t) = global_time[0] + t  // for 1:1 timescale
```

For variable-rate global time, interpolate from the channel's sample rate.

## Common Channel Names

PDS channel names are typically more verbose than MoTeC. Match case-insensitively.

### Speed
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `Corr Speed` | 100 Hz | float32 | `km/h` |
| `Ground Speed` | 100 Hz | float32 | `km/h` |
| `Wheel Speed AVG` | 100 Hz | float32 | `km/h` |
| `Speed_Ref` | 100 Hz | float32 | `km/h` |
| `VehRefSpeed` | 100 Hz | float32 | `km/h` |
| `Speed_WSPD_App` | 100 Hz | float32 | `km/h` |
| `USpeed` | 50 Hz | float32 | `km/h` |

### Throttle
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `Driver Throttle Pos` | 50 Hz | float32 | `%` |
| `Accel Pedal Pos` | 50 Hz | float32 | `%` |
| `FBWDriverTPS` | 50 Hz | float32 | `%` |
| `PPS` | 50 Hz | float32 | `%` |
| `TPSReal` | 50 Hz | float32 | `%` |

### Brake
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `Brake Pressure F` | 100 Hz | float32 | `bar` |
| `Brake Pressure FR` | 100 Hz | float32 | `bar` |

### Steering
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `Steering Angle` | 50 Hz | float32 | `deg` |

### Gear
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `Gear_Pos` | 10 Hz | int/float | integer (0=N, 1–6) |
| `GearPosDisplay` | 10 Hz | int/float | integer |

### G-Forces
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `G Force Long` | 100 Hz | float32 | `g` |
| `I_Accel_Long` | 100 Hz | float32 | `g` |
| `FIA_AccelX` | 100 Hz | float32 | `g` |

### Dampers
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `X_FL_DAMPER` | 200 Hz | float32 | `mm` |
| `X_FR_DAMPER` | 200 Hz | float32 | `mm` |
| `X_RL_DAMPER` | 200 Hz | float32 | `mm` |
| `X_RR_DAMPER` | 200 Hz | float32 | `mm` |
| `Damper Travel FL` | 200 Hz | float32 | `mm` |
| `Damper Travel FR` | 200 Hz | float32 | `mm` |
| `Damper Travel RL` | 200 Hz | float32 | `mm` |
| `Damper Travel RR` | 200 Hz | float32 | `mm` |

### Lap Detection
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `Lap_Beacon` | 10 Hz | uint8 | binary (0/1) |
| `Lap_Beacon_Trig` | 10 Hz | uint8 | binary |
| `LapTrigger` | 10 Hz | uint8 | binary |
| `Lap Number` | 1 Hz | int | integer |
| `Lap Time` | 1 Hz | float32 | `s` |
| `Previous Lap Time` | 1 Hz | float32 | `s` |
| `Lap Distance Corrected` | 50 Hz | float32 | `m` |
| `Lap Distance` | 50 Hz | float32 | `m` |

### GPS / Time
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `FIA_GpsTimeUTC` | 1–10 Hz | float32 | Unix timestamp (s) |
| `Global Time` | 1 Hz | float32 | Unix timestamp (s) |

## Key Differences from MoTeC .ld

| Aspect | MoTeC .ld | Pi/Cosworth .pds |
|--------|-----------|------------------|
| Files | Two files (.ld + .ldx) | Single file |
| Strings | Latin-1 (ISO 8859-1) | UTF-16LE |
| Channel list | Linked list (prev/next pointers) | Flat array (directory-indexed) |
| Sample data | Contiguous per channel | Chunk-based (multi-segment) |
| Integer conversion | Formula (shift/mul/scale/dec) | None — stored in physical units |
| Lap boundaries | Separate .ldx XML with beacon µs | Inferred from telemetry channels |
| Session metadata | Embedded in file header | Encoded in filename |
| Channel marker | None | `0x7c72` uint64 at record start |
| Typical file size | 5–50 MB | 50–200 MB |

## Implementation Checklist

1. ☐ Read file, parse directory at offset `0x80`
2. ☐ Find layout: three consecutive directory entries (defs / chunks / next)
3. ☐ Scan for first `0x7c72` marker to find true definitions start
4. ☐ Detect record size from gap between consecutive markers
5. ☐ Parse channel definitions (id, name, unit, type_code)
6. ☐ Scan/align chunk index start, parse chunk records
7. ☐ Group chunks by channel_id, sort by (order, data_ptr)
8. ☐ Decode sample data per type_code (uint8/uint16/int32/uint32/float32)
9. ☐ Map channel names to unified fields (speed, throttle, brake, etc.)
10. ☐ Detect lap boundaries from beacon/laptime/lapnumber/distance channels
11. ☐ Refine lap times using `previous lap time` channel if available
12. ☐ Extract session metadata from filename
13. ☐ Extract global time channel for video sync
14. ☐ Resample all channels to common frequency

## Robustness Notes

- **Directory bounds**: cap at 64 entries, validate offsets are within file
- **Marker scanning**: scan up to 8192 bytes to find first `0x7c72`
- **Chunk alignment**: scan up to 4096 bytes to find first valid chunk
- **Invalid chunks**: reject if `channel_id <= 0`, `channel_id != channel_id_2`, `sample_count <= 0`, or `data_ptr >= file_size`
- **Missing channels**: many channels are optional; only speed is required
- **Multi-chunk sort**: always sort by `(order, data_ptr)` before concatenating
- **UTF-16 strings**: read as pairs of uint16, stop at null (0x0000), trim whitespace
