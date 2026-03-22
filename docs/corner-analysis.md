# Corner Analysis System

Analyzes driver performance through individual corners by extracting speed, pedal, and steering metrics from telemetry data, then scoring the result against a reference lap. Ported from ac-tracer `corner_analysis.lua` + `scoring.lua`.

## Source Files

| File | Role |
|------|------|
| `CornerAnalysis.swift` | Analysis engine (`CornerAnalyzer`), scoring (`CornerScoring`), data structs |
| `Corners.swift` | Corner zone definitions, CSV loading, auto-generation from braking data |
| `CornerAnalysisView.swift` | Comparison view (current vs reference lap) |
| `SingleCornerInspector.swift` | Single-lap inspector (no reference needed) |

## Corner Definitions

### Data Model

```swift
struct Corner: Identifiable, Equatable {
    var name: String
    var start: Double  // 0-1 normalized track fraction
    var end: Double    // 0-1 normalized track fraction
    var mid: Double    // computed: (start + end) / 2
}
```

All positions are **normalized fractions** (0.0 = lap start, 1.0 = lap end) of the total lap distance.

### Loading from CSV

Corner definitions are stored as CSV files in `~/src/tries/2025-12-30-tobi-ac-tracer/corners/`. Format:

```csv
name,start,end
Turn 1,0.012345,0.045678
Turn 2,0.089012,0.123456
```

Track matching uses a two-step process:

1. **Alias table** -- hardcoded mappings for known tracks:
   - `"daytona"` -> `ier_daytona.csv`
   - `"sebring"` -> `lilski_sebring.csv`

2. **Fuzzy filename scan** -- strips spaces, hyphens, underscores from both the track name and CSV filenames, then checks `contains()` in both directions.

Corners are returned sorted by `start` ascending.

### Auto-Generation from Braking Data

When no CSV file matches, `Corners.generate(from:track:)` creates corner zones automatically from the lap's brake channel:

1. **Threshold**: 15% of peak brake pressure in the lap. Requires peak > 2 bar (rejects laps without real braking data).

2. **Zone detection**: Walk the brake array. A zone starts when brake exceeds the threshold and ends when brake drops below 50% of threshold (hysteresis to avoid false exits).

3. **Minimum duration**: Zones shorter than 5 samples (~0.1s at 50 Hz) are discarded.

4. **Merge close zones**: Zones within 50 samples (~1s at 50 Hz) of each other are merged into one.

5. **Extend zones**: Each zone is expanded to capture approach and exit:
   - Start: 30% of braking zone width earlier
   - End: 60% of braking zone width later
   - Clamped to `[0, n-1]`

6. **Naming**: Auto-generated corners are named `Turn 1`, `Turn 2`, etc.

Auto-generated corners can be saved back to CSV via `Corners.saveNew(track:corners:)`.

## Single-Corner Analysis

`CornerAnalyzer.analyze(lap:corner:totalDistance:)` extracts metrics from one lap through one corner.

### Index Mapping

The corner's normalized fractions are mapped to sample indices:

```
iStart = max(0, floor(corner.start * (n - 1)))
iEnd   = min(n - 1, floor(corner.end * (n - 1)))
```

Where `n` = total samples in the lap. All analysis operates on `iStart...iEnd`.

### Extracted Metrics

#### Speed Points

| Metric | Definition |
|--------|-----------|
| `entrySpeed` | Maximum speed from `iStart` to apex index |
| `apexSpeed` | Minimum speed in the entire corner range |
| `exitSpeed` | Maximum speed from apex index to `iEnd` |
| `apexFrac` | Normalized position of the apex (min speed sample) |

#### Key Positions

| Metric | Definition |
|--------|-----------|
| `brakeFrac` | First sample where `brake > 0.5 bar` (normalized position) |
| `liftOffFrac` | First sample where throttle drops below 90% after being at/above 90% |

#### Timing & Mechanical

| Metric | Definition |
|--------|-----------|
| `cornerTime` | `time[iEnd] - time[iStart]` in seconds |
| `maxSteeringDeg` | Maximum `abs(steering)` in degrees across the corner |
| `minGear` | Lowest gear used in the corner |

#### Brake Attack Metrics

Computed only when `brakeFrac` exists and `peakBrake > 1 bar`:

| Metric | Unit | Definition |
|--------|------|-----------|
| `brakeAttackRate` | bar/s | `peakBrake / rampTime`, where rampTime = time from first brake contact (>0.5 bar) to peak brake pressure |
| `brakeInitialPct` | % | Percentage of peak brake pressure reached within the first 0.15 seconds of brake contact: `(brake[firstBrakeIdx + 0.15s] / peakBrake) * 100` |
| `brakeReleaseRate` | bar/s | `peakBrake / releaseTime`, where releaseTime = time from peak brake to brake dropping below 5% of peak (trail brake exit quality) |
| `peakBrake` | bar | Maximum brake pressure in the corner |

#### Throttle Attack Metrics

| Metric | Unit | Definition |
|--------|------|-----------|
| `throttleOnDelay` | s | Time from apex to first throttle > 10% |
| `timeToFullThrottle` | s | Time from first throttle (>10%) to full throttle (>95%) |
| `throttleAttackRate` | %/s | `85 / timeToFullThrottle * 100` (the 85% represents the range from 10% to 95%) |

## Corner Comparison

`CornerAnalyzer.compare(current:reference:corner:)` analyzes both laps independently, then computes deltas.

### Position Deltas

Brake point, lift-off point, and apex position deltas are converted to **meters**:

```
meters = (currentFrac - referenceFrac) * totalDistance
```

With wraparound correction: if `|delta| > totalDistance * 0.5`, the delta is adjusted by `+/- totalDistance` to handle corners near the start/finish line.

Positive meters = **later/deeper** than reference.

### Speed Traces

Both laps are resampled across the corner zone for mini-graphs:
- Speed traces: 60 samples
- Pedal traces (throttle + brake): 80 samples

Resampling uses linear interpolation between the corner's start and end fractions.

### Coaching Notes

`collectNotes()` generates contextual feedback by comparing the two analysis results:

| Condition | Threshold | Note |
|-----------|-----------|------|
| Entry speed difference | > 10 km/h | "Entry X km/h faster/slower" |
| Steering angle difference | > 10 degrees | "X more/less steering" |
| Gear difference | any | "N gear(s) higher/lower" |
| Coasting difference (brake meters - lift meters) | > 15m | "Xm more/less coasting" |
| Brake attack rate difference | > 50 bar/s | "Brake attack X bar/s sharper/softer" (warning if >100) |
| Initial brake hit difference | > 15% | "Initial brake X% more decisive/gradual" |
| Throttle on delay difference | > 0.15s | "Throttle Xs later/earlier after apex" (warning if >0.3s) |
| Throttle attack rate difference | > 50 %/s | "Throttle attack X%/s more aggressive/progressive" |

Each note has a severity: `.info`, `.warning`, or `.error`.

## Scoring System

`CornerScoring.calculate()` produces a 0-100 score comparing the current lap's corner to the reference.

### Component Weights

| Component | Weight | Input |
|-----------|--------|-------|
| Time | 40% | Corner time delta (seconds) |
| Exit speed | 25% | Exit speed delta (km/h) |
| Apex speed | 15% | Apex speed delta (km/h) |
| Brake point | 10% | Brake position delta (meters) |
| Lift-off point | 10% | Lift-off position delta (meters) |

### Scoring Functions

**Time** (baseline 100, clamped 0-110):
- Each 0.1s slower: -15 points (`100 - delta * 150`)
- Each 0.1s faster: +5 points (`100 - delta * 50`)

**Exit speed** (baseline 100, clamped 0-115):
- Each km/h faster: +3 points
- Each km/h slower: -5 points

**Apex speed** (baseline 100, clamped 0-110):
- Each km/h faster: +2 points
- Each km/h slower: -3 points

**Brake point** (default 80 when no data):
- Later braking + within 0.15s of reference time: `min(120, 100 + meters * 3)` -- rewards bravery when fast
- Later braking + >0.15s slower: fixed 90 -- no reward for late braking when slow
- Earlier braking: `max(60, 100 + meters)` -- mild penalty, 1 pt per meter

**Lift-off point** (default 80 when no data):
- Later lift-off + within 0.15s: `min(115, 100 + meters * 2)`
- Later lift-off + >0.15s slower: fixed 90
- Earlier lift-off: `max(60, 100 + meters * 0.5)`

### Final Score

```
score = time * 0.40 + exit * 0.25 + apex * 0.15 + brake * 0.10 + liftOff * 0.10
```

Clamped to `[0, 100]`.

### Score Color Coding

| Score Range | Color |
|-------------|-------|
| >= 90 | Purple |
| >= 80 | Green |
| >= 60 | Yellow |
| < 60 | Red |

## UI Components

### CornerAnalysisView (Comparison Mode)

Used when both a current and reference lap are selected. Displays:

1. **Corner picker**: Horizontal scrollable buttons showing corner name + score (color-coded).
2. **Score header**: Large score number with progress bar, corner name, time delta (green = faster, red = slower).
3. **Speed graph** (140px): Canvas-drawn speed traces for both laps. Fill segments are colored green (current faster by >1 km/h), red (slower by >1 km/h), or gray (similar). Reference line is white; current line uses the primary color. Yellow vertical line marks the apex.
4. **Pedal graph** (80px): Throttle (green) and brake (red) traces overlaid. Reference traces are dimmer (0.3 opacity). Yellow vertical line marks the brake point.
5. **Delta bars**: Centered horizontal bars for entry/apex/exit speed deltas (green = faster right, red = slower left). Position markers for brake/lift/apex (meters late/early). Pedal attack comparison bars (side-by-side current vs reference).
6. **Notes section**: Color-coded coaching feedback (orange = info, yellow = warning, red = error).

### SingleCornerInspector (Solo Mode)

Used when only one lap is selected (no reference). Displays per corner:

1. **Corner picker**: Shows corner name + apex speed (cyan).
2. **Header card**: Corner name, corner time, gear, max steering angle.
3. **Speed graph** (140px): Single trace with fill under curve. Yellow apex marker with speed label. Green entry/exit labels.
4. **Pedals graph** (80px): Throttle (green) and brake (red) traces with 25/50/75% grid lines.
5. **Steering graph** (50px): Absolute steering angle trace (yellow) with peak marker.
6. **Pedal attack card**: Four brake metrics (attack rate, initial hit, release rate, peak) and three throttle metrics (attack rate, on delay, time to full) displayed as icon + value + label. Color coding: green (great), yellow (good), orange (needs work), gray (no data).
7. **Speed card**: Entry -> Apex -> Exit speed display with chevron arrows.
8. **Details card**: Speed drop, speed gain, corner time, min gear, max steering.

### Pedal Attack Color Thresholds

| Metric | Good | Great |
|--------|------|-------|
| Brake attack rate | >= 200 bar/s | >= 400 bar/s |
| Initial brake hit | >= 70% | >= 90% |
| Brake release rate | < 100 bar/s = green, < 200 = yellow, >= 200 = orange |
| Throttle attack rate | >= 150 %/s | >= 300 %/s |
| Throttle on delay | < 0.3s = green, < 0.6s = yellow, >= 0.6s = red |
| Time to full throttle | < 0.5s = green, < 1.0s = yellow, >= 1.0s = red |
