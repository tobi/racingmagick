# Driver Analysis System

Builds comprehensive driver profiles by aggregating lap data across sessions and tracks. Computes pace scores, consistency metrics, improvement trends, driving style fingerprints, and per-corner performance percentiles.

## Source Files

| File | Role |
|------|------|
| `DriverAnalysis.swift` | Analysis engine (`DriverAnalyzer`), data structs (`DriverProfile`, `TrackStat`, `CornerStat`, `Trend`) |
| `DriverProfileView.swift` | Full-page driver profile UI with hero card, stats grid, corner performance table, and track cards |

## Data Model

### DriverProfile

Top-level container for one driver's aggregated performance.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `String` | Driver tag (unique identifier) |
| `name` | `String` | Display name (editable via `store.renameDriver`) |
| `totalLaps` | `Int` | Total laps across all sessions and tracks |
| `tracksVisited` | `Int` | Number of distinct tracks driven |
| `trackStats` | `[TrackStat]` | Per-track performance breakdown, sorted by score descending |
| `cornerStats` | `[CornerStat]` | Per-corner stats across all laps at each track |
| `overallScore` | `Int` | 0-100 average of all track scores |
| `consistencyScore` | `Int` | 0-100 derived from top-quartile standard deviation |
| `improvementTrend` | `Trend` | Overall direction: `.improving`, `.stable`, `.regressing` |

### TrackStat

Per-track performance data for a single driver.

| Field | Type | Description |
|-------|------|-------------|
| `trackName` | `String` | Track identifier |
| `totalLaps` | `Int` | Laps at this track |
| `bestTimeMs` | `Double` | Driver's personal best (milliseconds) |
| `top25AvgMs` | `Double` | Average of the driver's top 25% laps |
| `medianMs` | `Double` | Median lap time |
| `consistencyMs` | `Double` | Standard deviation of top 25% lap times |
| `gapToBestMs` | `Double` | `bestTimeMs - fieldBestMs` (positive = slower) |
| `gapToBestPct` | `Double` | Gap as percentage of field best |
| `fieldBestMs` | `Double` | Fastest lap by any driver at this track |
| `fieldBestDriver` | `String` | Name of the fastest driver |
| `score` | `Int` | 0-100 vs field best (see scoring formula) |
| `latestSessionTop25Ms` | `Double` | Top 25% average of the most recent session |
| `allTimeTop25Ms` | `Double` | Top 25% average across all sessions |
| `trend` | `Trend` | Performance direction at this track |
| `trendDeltaMs` | `Double` | `latestSessionTop25 - allTimeTop25` (positive = slower) |
| `sessionStems` | `[String]` | File stems of all sessions at this track (sorted) |
| `latestSessionStem` | `String` | Most recent session's file stem |
| `avgBrakeForce` | `Double` | Average peak brake pressure in top 25% laps (bar) |
| `avgTrailPct` | `Double` | Average % of samples spent trail braking in top 25% laps |
| `avgRollingPct` | `Double` | Average % of samples coasting (no throttle, no brake) |
| `avgThrottleOnPct` | `Double` | Average % of samples with throttle > 90% |

### CornerStat

Per-corner performance for one driver at one track, compared against all drivers.

| Field | Type | Description |
|-------|------|-------------|
| `trackName` | `String` | Track this corner belongs to |
| `cornerName` | `String` | Corner name (from corner definitions) |
| `avgTime` | `Double` | Driver's average time through this corner (seconds) |
| `bestTime` | `Double` | Driver's best time through this corner |
| `fieldAvg` | `Double` | Average time across all drivers |
| `fieldBest` | `Double` | Fastest time by any driver |
| `percentile` | `Int` | 0-100, percentage of all times the driver's average beats (100 = fastest) |
| `sampleCount` | `Int` | Number of laps with this corner timed |

### Trend

```swift
enum Trend: String {
    case improving = "Improving"   // symbol: "↑"
    case stable = "Stable"         // symbol: "→"
    case regressing = "Regressing" // symbol: "↓"
}
```

## Analysis Engine

`DriverAnalyzer.buildProfiles(from:)` builds all driver profiles from the `TelemetryStore`. Runs on `@MainActor`.

### Step 1: Group Laps by Driver

All laps from `store.allLaps` are grouped by `driverTag`. Each `LapEntry` provides `driverTag`, `driverName`, `track`, `timeMs`, `fileStem`, and `cornerTimes` (a `[LapCornerTime]` with `name` and `timeSeconds`).

### Step 2: Compute Field Bests

For each track, the fastest lap across all drivers is recorded:

```
fieldBest[track] = min(lap.timeMs) across all drivers
```

### Step 3: Build Global Corner Time Stats

All corner times from all drivers are pooled into a dictionary keyed by `"track|cornerName"`. This is used later for percentile calculations.

### Step 4: Per-Track Statistics

For each driver, laps are grouped by track, then sorted by `timeMs` ascending.

#### Lap Time Statistics

| Metric | Formula |
|--------|---------|
| Best | `times[0]` |
| Top 25% count | `max(1, n / 4)` |
| Top 25% average | Mean of the fastest 25% of laps |
| Median | `times[n / 2]` |
| Consistency (std dev) | `sqrt(variance)` of top 25% times |

#### Track Score

```
gapPct = (bestTimeMs - fieldBestMs) / fieldBestMs * 100
score = clamp(100 - gapPct * 30, 0, 100)
```

Each 0.1% slower than the field best costs 3 points. A driver matching the field best scores 100.

#### Trend Detection

Laps are grouped by `fileStem` (session file). The latest session is the last stem alphabetically. Its top 25% average is compared to the all-time top 25% average:

```
trendDelta = latestSessionTop25Avg - allTimeTop25Avg
```

| Condition | Trend |
|-----------|-------|
| `trendDelta < -200` (ms) | `.improving` (latest session >0.2s faster) |
| `trendDelta > 500` (ms) | `.regressing` (latest session >0.5s slower) |
| Otherwise | `.stable` |

#### Driving Style Metrics

Computed from the **top 25% laps** at each track using the `UnifiedLap` data:

**Peak brake force**: Maximum value in the brake channel (bar).

**Trail brake percentage**: Percentage of samples in "trail braking" state. Trail braking is defined as:
1. A heavy braking event occurs (brake > 50% of peak)
2. Then brake drops to between 5% and 10% of peak -- this range counts as trail braking
3. When brake drops below 5% of peak, the heavy braking event ends

**Coasting percentage**: Percentage of samples where both throttle < 2% (0.02 ratio) AND brake < 0.5 bar.

**Throttle on percentage**: Percentage of samples where throttle > 90% (0.9 ratio).

### Step 5: Overall Scores

**Overall score**: Simple average of all per-track scores.

**Consistency score**: Based on average standard deviation across tracks:

```
consistencyScore = clamp(100 - avgStdDev / 10, 0, 100)
```

Where `avgStdDev` is the mean of `consistencyMs` values across all tracks. Lower std dev = higher consistency score. A 1-second (1000ms) std dev yields a consistency score of 0.

**Overall trend**: Majority vote across per-track trends. Requires a margin of 2:

| Condition | Overall Trend |
|-----------|---------------|
| `improving count > regressing count + 1` | `.improving` |
| `regressing count > improving count + 1` | `.regressing` |
| Otherwise | `.stable` |

### Step 6: Per-Corner Percentiles

For each corner the driver has data for:

1. Collect the driver's times through that corner across all laps at that track
2. Compute driver's average and best time
3. Compare against the global pool (all drivers, all laps) for that track+corner
4. Percentile = percentage of all field times that are slower than the driver's average:

```
percentile = (count of fieldTimes > driverAvg) / totalFieldTimes * 100
```

A percentile of 100 means the driver's average beats every recorded time. Default is 50 when only one sample exists.

### Output

Profiles are returned sorted by `overallScore` descending (best drivers first).

## UI: DriverProfileView

### Hero Card

- **Pace score ring**: Circular progress indicator (80px diameter) showing `overallScore` with color coding.
- **Driver name**: Editable via pencil button. Uses `store.renameDriver(tag:newName:)`.
- **Summary pills**: Total laps, tracks visited, improvement trend arrow.
- **Consistency ring**: Circular progress indicator (60px) showing `consistencyScore` in cyan.

### Stats Grid

Four metric cards aggregated across all tracks:

| Card | Value | Color |
|------|-------|-------|
| Throttle On | Average `avgThrottleOnPct` | Green |
| Avg Brake | Average `avgBrakeForce` | Red |
| Trail Brake | Average `avgTrailPct` | Orange |
| Coasting | Average `avgRollingPct` | Yellow if >5%, gray otherwise |

### Corner Performance Table

Shown when `cornerStats` is non-empty. Grouped by track, each section displays a table:

| Column | Source | Color |
|--------|--------|-------|
| Corner | `cornerName` | White |
| Best | `bestTime` (formatted `%.3f`) | Green |
| Avg | `avgTime` | Default |
| Field Best | `fieldBest` | Purple |
| Delta Field | `avgTime - fieldBest` (formatted `%+.3f`) | Green (<0.05s), Yellow (<0.2s), Red (>=0.2s) |
| Pctile | Percentile bar + number | Green (>=80), Yellow (>=50), Red (<50) |
| N | `sampleCount` | Gray |

### Track Performance Cards

One card per track, sorted by score descending. Each card contains:

1. **Header**: Track name (cyan), trend badge (colored pill), score number.

2. **Times row**: Best (green, bold), Top 25%, Median, Field Best (purple) -- all formatted as `M:SS.mmm`.

3. **Gap and consistency row**: Gap to best (green if leader, yellow if <1%, red otherwise), consistency as `+/- X.XXXs` (green <300ms, yellow <600ms, red otherwise), lap count, session count.

4. **Latest session trend**: Shows latest session top 25% time with delta from all-time (green if faster, red if slower).

5. **Driving style bars**: Three horizontal bars:
   - Throttle: fraction = `avgThrottleOnPct / 100` (green)
   - Trail: fraction = `avgTrailPct / 10` (orange, scaled to ~10% max)
   - Coasting: fraction = `avgRollingPct / 15` (yellow if >5%)

6. **Session jump buttons**: Up to 3 most recent session stems displayed as clickable buttons (format: `"YYYY RUN"`). Clicking selects the best lap from that session via `store.selectPrimary()`.

### Score Color Coding

| Range | Color |
|-------|-------|
| >= 95 | Purple |
| >= 85 | Green |
| >= 70 | Yellow |
| < 70 | Red |

### Time Formatting

All lap times use `M:SS.mmm` format:

```swift
let min = Int(totalSec) / 60
let sec = totalSec - Double(min * 60)
// Output: "1:42.567"
```

### Trend Colors

| Trend | Color |
|-------|-------|
| Improving | Green |
| Stable | Secondary (gray) |
| Regressing | Red |
