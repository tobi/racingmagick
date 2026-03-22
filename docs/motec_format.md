# MoTeC .ld / .ldx Binary File Format Specification

Reverse-engineered from MoTeC i2 Pro telemetry files. Verified against real Oreca 07 LMP2 data. Sufficient to implement a complete parser.

## Overview

A MoTeC telemetry session consists of two files:

| File | Format | Contents |
|------|--------|----------|
| `.ld` | Binary, little-endian | Header, channel metadata (linked list), channel sample data |
| `.ldx` | XML (UTF-8) | Lap beacon timestamps, session metadata |

## .ld File Structure

All multi-byte integers are **little-endian**. Strings are **Latin-1** (ISO 8859-1), null-terminated, zero-padded.

### File Header (offset 0x00, ~512 bytes)

| Offset | Size | Type | Field | Notes |
|--------|------|------|-------|-------|
| 0x00 | 4 | uint32 | `magic` | Always `0x00000040` (64 decimal). Reject file if different. |
| 0x04 | 4 | uint32 | _reserved_ | Always 0 |
| 0x08 | 4 | uint32 | `channel_meta_ptr` | Byte offset to first channel metadata block |
| 0x0C | 4 | uint32 | `channel_data_ptr` | Byte offset to start of channel data area |
| 0x10–0x23 | 20 | — | _reserved_ | Zeros |
| 0x24 | 4 | uint32 | `event_ptr` | Byte offset to event info block (0 = none) |
| 0x28–0x5D | 54 | — | _reserved_ | |
| 0x5E | 16 | string | `date` | Session date, format `"dd/MM/yyyy"`, e.g. `"27/01/2023"` |
| 0x6E | 16 | — | _reserved_ | |
| 0x7E | 16 | string | `time` | Session start time, format `"HH:mm:ss"`, e.g. `"12:00:00"` |
| 0x8E | 16 | — | _reserved_ | |
| 0x9E | 64 | string | `driver` | Driver name, e.g. `"Mikkel Jensen"` |
| 0xDE | 64 | string | `vehicle_id` | Vehicle identifier, e.g. `"MQ12Di_LMP2 #477"` |
| 0x11E | 64 | — | _reserved_ | |
| 0x15E | 64 | string | `venue` | Track/venue name, e.g. `"DIS"` |

### Event Info Block (at `event_ptr`)

Optional. Only present when `event_ptr > 0` and points within the file:

| Offset | Size | Type | Field |
|--------|------|------|-------|
| event_ptr + 0 | 64 | string | `event_name` |

### Channel Metadata Block (124 bytes each, linked list)

Channels form a **doubly-linked list**. Each block is exactly **124 bytes** (0x7C).

Start at `channel_meta_ptr`, follow `next_addr` until 0 or beyond file end.

| Offset | Size | Type | Field | Notes |
|--------|------|------|-------|-------|
| +0x00 | 4 | uint32 | `prev_addr` | Byte offset to previous channel block (0 for first) |
| +0x04 | 4 | uint32 | `next_addr` | Byte offset to next channel block (0 for last) |
| +0x08 | 4 | uint32 | `data_ptr` | Byte offset to this channel's sample data |
| +0x0C | 4 | uint32 | `n_data` | Number of samples |
| +0x10 | 2 | uint16 | `_id` | Internal channel ID (not used for parsing) |
| +0x12 | 2 | uint16 | `datatype_a` | Data type class (see table below) |
| +0x14 | 2 | uint16 | `datatype` | Bytes per sample: `2` or `4` |
| +0x16 | 2 | uint16 | `rec_freq` | Recording frequency in Hz |
| +0x18 | 2 | int16 | `shift` | Integer conversion: additive offset |
| +0x1A | 2 | int16 | `mul` | Integer conversion: multiplicative factor |
| +0x1C | 2 | int16 | `scale` | Integer conversion: divisor |
| +0x1E | 2 | int16 | `dec_places` | Integer conversion: decimal exponent |
| +0x20 | 32 | string | `name` | Channel name, e.g. `"Corr Speed"` |
| +0x40 | 12 | string | `unit` | Unit string, e.g. `"m/s"`, `"km/h"`, `"bar"`, `"deg"`, `"ratio"` |
| +0x4C | 8 | string | `_short_name` | Short name (often empty, not essential) |
| +0x54 | 4 | uint32 | `_display_min` | Display range minimum (not needed for data) |
| +0x58 | 4 | uint32 | `_display_max` | Display range maximum |
| +0x5C | 4 | float32 | `_range_max` | Physical range maximum (e.g. 200.0 for speed) |
| +0x60 | 4 | float32 | `_range_min` | Physical range minimum (e.g. 0.0 or -31.1) |
| +0x64 | 8 | — | _reserved_ | |
| +0x6C | 16 | — | _padding_ | Zeros to fill 124 bytes |

**Note**: Fields prefixed with `_` are informational/display only. Only the fields without `_` prefix are required for correct data extraction.

### Data Type Classes (`datatype_a`)

| Value | Meaning | Data encoding |
|-------|---------|---------------|
| 0x07 | Float | IEEE 754 float. No conversion needed. |
| 0x03 | Signed integer | Apply integer-to-physical conversion formula. |
| Other | Signed integer | Treat same as 0x03. |

### Channel Data

Located at `data_ptr`. Contiguous array of `n_data` samples.

#### Float data (`datatype_a == 0x07`)

| `datatype` | Read as | Size |
|------------|---------|------|
| 4 | IEEE 754 float32 (little-endian) | 4 bytes × n_data |
| 2 | float16 (rare, fallback to zeros) | 2 bytes × n_data |

Values are already in physical units — no conversion needed.

#### Integer data (`datatype_a != 0x07`)

| `datatype` | Read as | Size |
|------------|---------|------|
| 2 | Signed int16 (little-endian) | 2 bytes × n_data |
| 4 | Signed int32 (little-endian) | 4 bytes × n_data |

**Conversion formula** (integer → physical value):

```
scale_eff = (scale == 0) ? 1 : scale
mul_eff   = (mul == 0)   ? 1 : mul

value = (raw / scale_eff * 10^(-dec_places) + shift) * mul_eff
```

Example: `P_F_BRAKE` channel with scale=1, dec_places=1, shift=0, mul=1:
- raw int16 value = 423
- value = (423 / 1 × 10⁻¹ + 0) × 1 = 42.3 bar

### Linked List Iteration

```python
addr = header.channel_meta_ptr
channels = []
while addr > 0 and addr + 124 <= file_size:
    ch = parse_channel_meta(data, addr)
    channels.append(ch)
    if ch.next_addr == 0 or ch.next_addr <= addr:
        break  # end of list or backward pointer (corrupt)
    addr = ch.next_addr
```

Safety limit: cap at ~200 channels to protect against corrupt files.

## .ldx File Structure

XML file, UTF-8 encoded. Same base filename as the `.ld` file.

### Structure

```xml
<?xml version="1.0"?>
<LDXFile>
  <Layers>
    <Layer>
      <MarkerBlock>
        <MarkerGroup>
          <Marker Time="0" />
          <Marker Time="67340000" />
          <Marker Time="135280000" />
        </MarkerGroup>
      </MarkerBlock>
    </Layer>
  </Layers>
</LDXFile>
```

### Parsing

Extract all `Time` attributes from `<Marker>` elements using regex or XML parser:

```
Pattern: <Marker[^>]* Time="(\d+)"
```

### Time Units

`Time` values are in **microseconds** (µs). Convert to seconds:

```
time_seconds = Time / 1_000_000
```

### Lap Computation

Sort beacon times ascending. Each consecutive pair defines a lap:

```
for i in 0..(beacons.count - 2):
    lap.start = beacons[i]
    lap.end   = beacons[i + 1]
    lap.duration_ms = (lap.end - lap.start) * 1000
```

**Edge cases**:
- 0 or 1 beacons: treat entire session as one lap (`start=0, end=max_channel_duration`)
- `.ldx` file missing: same fallback

## Common Channel Names

Names are **case-insensitive** for matching. Listed by priority (use first match).

### Speed
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `Corr Speed` | 100 Hz | float32 | `m/s` or `km/h` |
| `Ground Speed` | 100 Hz | float32 | `km/h` |
| `Wheel Speed AVG` | 100 Hz | float32 | `km/h` |
| `Aero Speed` | 20 Hz | float32 | `km/h` |

### Throttle
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `Driver Throttle Pos` | 50 Hz | float32 | `ratio` (0.0–1.0) or `%` (0–100) |
| `Throttle Pos` | 50 Hz | float32 | `ratio` or `%` |

### Brake
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `P_F_BRAKE` | 100 Hz | int16 | `bar` (via conversion) |
| `Brake Pos` | 100 Hz | float32 | `ratio` (0.0–1.0) |

### Steering
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `Steering Angle` | 50 Hz | float32 | `deg` (steering wheel degrees) |

### Gear
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `Gear` | 10 Hz | float32 | integer (0=N, 1–6) |

### G-Forces
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `G Force Long` | 50–100 Hz | float32 | `g` |

### Dampers
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `X_FL_DAMPER` | 200 Hz | float32 | `mm` |
| `X_FR_DAMPER` | 200 Hz | float32 | `mm` |
| `X_RL_DAMPER` | 200 Hz | float32 | `mm` |
| `X_RR_DAMPER` | 200 Hz | float32 | `mm` |

### Engine
| Name | Typical Freq | Type | Unit |
|------|-------------|------|------|
| `Engine RPM` | 100 Hz | float32 | `rpm` |

## Unit Normalization

### Speed → km/h
| Unit | Factor |
|------|--------|
| `m/s` | × 3.6 |
| `km/h` | × 1.0 |
| `mph` | × 1.60934 |

### Brake Pressure → bar
| Unit | Factor |
|------|--------|
| `bar` | × 1.0 |
| `psi` | × 0.0689476 |
| `kpa` | × 0.01 |

### Throttle → 0.0–1.0
- Unit `ratio`: already 0.0–1.0
- Unit `%` or values > 1.5: divide by 100
- Unit `deg`: divide by 100
- Unit `rad`: divide by 1.745 (100° in radians)

### Steering → degrees
- Unit `deg`: already degrees
- Unit `rad`: multiply by 180/π

## Resampling

Channels have different native frequencies (10 Hz to 200 Hz). Resample to a unified rate (typically 50 Hz) using linear interpolation:

```
output_count = floor(duration * target_freq) + 1

for i in 0..<output_count:
    t = i / target_freq           // seconds
    src_pos = t * src_freq        // fractional source index
    lo = floor(src_pos)
    hi = min(lo + 1, src_count - 1)
    frac = src_pos - lo
    output[i] = data[lo] + (data[hi] - data[lo]) * frac
```

## Implementation Checklist

1. ☐ Read file, validate `magic == 0x40`
2. ☐ Parse header strings (date, time, driver, vehicle, venue)
3. ☐ Walk channel linked list from `channel_meta_ptr` (124-byte blocks)
4. ☐ For each channel: read `n_data` samples from `data_ptr`
5. ☐ Float channels (`datatype_a == 0x07`): read as float32, no conversion
6. ☐ Integer channels: read as int16/int32, apply conversion formula
7. ☐ Parse `.ldx` companion file for beacon timestamps (microseconds)
8. ☐ Compute laps from consecutive beacon pairs
9. ☐ Map channel names (case-insensitive) to unified fields
10. ☐ Apply unit conversions (speed→km/h, brake→bar, throttle→0-1)
11. ☐ Resample all channels to common frequency
12. ☐ Compute cumulative distance from speed (if no distance channel)

## Robustness Notes

- **Bounds checking**: `data_ptr + n_data * datatype` may exceed file size — clamp `n_data`
- **Empty channels**: `n_data == 0` is valid, return empty array
- **Missing `.ldx`**: fall back to single-lap mode (entire session = one lap)
- **Corrupt linked list**: `next_addr == 0`, `next_addr <= current_addr`, or `next_addr >= file_size` all terminate iteration
- **Division by zero**: `scale == 0` → use 1, `mul == 0` → use 1
- **String encoding**: Latin-1 (ISO 8859-1), not UTF-8
