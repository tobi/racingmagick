# RacecraftViewer Architecture

## Overview

RacecraftViewer is a macOS SwiftUI application for analyzing race telemetry from MoTeC (.ld) and Pi/Cosworth (.pds) data loggers. It displays time-series traces (speed, throttle, brake, steering, etc.) for a selected lap, optionally overlaying a reference lap for comparison. It also syncs onboard video to the telemetry cursor.

## Data Flow

```
Telemetry files (.ld, .pds)
        |
        v
  RaceTelemetry.parseFile()     <-- dispatches to MoTecParser or PiTelemetryParser
        |
        v
    SessionData                 <-- raw channels, mapping, laps, header
        |
        v
  SessionMetadataCache          <-- caches SessionSummary per file (FileSignature invalidation)
        |
        v
  TelemetryStore._loadSyncMultiple()
        |
        +---> TrackGroup > DateGroup > SessionGroup > [LapEntry]
        |
        +---> allLaps: [LapEntry]  (flat list for fast lookup)
        |
        v
  LapEntry.unified  (lazy)      <-- resampled UnifiedLap via SessionHandle
        |
        v
    SwiftUI Views               <-- TraceStackView, HeaderView, SidebarView, etc.
```

### Step by step

1. **File discovery**: `_telemetryFiles(in:)` recursively enumerates `.ld` and `.pds` files under configured session directories.

2. **Parsing & caching**: For each file, `SessionMetadataCache.summary(for:)` checks if a cached `SessionSummary` exists with a matching `FileSignature` (file size + modification date). On cache miss, it calls `RaceTelemetry.parseFile()` which dispatches to `MoTecParser.parseLDFile()` or `MoTecParser.parsePDSFile()`. The parsed `SessionData` is kept as a `preloadedSession` to avoid double-parsing.

3. **Grouping**: `_loadSyncMultiple()` groups laps into a hierarchy: `TrackGroup` (by venue name or folder) > `DateGroup` (by session date, reverse-chronological) > `SessionGroup` (by file stem) > `[LapEntry]` (sorted by lap index).

4. **Lazy loading**: Each `LapEntry` holds a `SessionHandle` (reference-counted, thread-safe). The `SessionHandle` caches the parsed `SessionData` and per-lap `UnifiedLap` objects. The full session parse only happens on first access of `.session` or `.unified` -- not during the initial scan.

5. **Channel unification**: `MoTecParser.unifyChannels()` resamples all channels to a common 50 Hz rate and normalizes units (speed to km/h, throttle to 0-1, brake to bar, steering to degrees). The result is a `UnifiedLap` struct with parallel arrays for each telemetry field.

6. **View rendering**: SwiftUI views bind directly to `TelemetryStore` properties. Selecting a lap sets `store.primary`, which triggers trace redraws. The reference lap is `store.compare` (explicit user selection only).

## Key Data Types

| Type | Purpose |
|------|---------|
| `SessionData` | Complete parsed session: header, raw channel arrays, channel-to-concept mapping, lap boundaries |
| `SessionSummary` | Lightweight cacheable metadata: file path, header fields, lap times. No raw channel data. |
| `UnifiedLap` | Resampled telemetry for one lap at 50 Hz: parallel arrays for time, speed, throttle, brake, steering, gear, dampers, GPS, etc. |
| `LapEntry` | UI-facing lap: id, track, driver, time, plus lazy access to `SessionData` and `UnifiedLap` via `SessionHandle` |
| `SessionHandle` | Thread-safe lazy loader. Caches `SessionData` and per-lap `UnifiedLap`. Uses `NSLock` for synchronization. |

## Lazy Loading Model

The app must handle hundreds of telemetry files without parsing them all upfront. This is achieved through two layers:

**SessionMetadataCache** (disk-based, singleton):
- Stores `SessionSummary` objects keyed by file path in `.cache/session-metadata.v2.json`.
- Each entry includes a `FileSignature` (file size + modification timestamp).
- On load, if the signature matches, the cached summary is returned without touching the telemetry file.
- On cache miss, the file is fully parsed. The parsed `SessionData` is returned alongside the summary as `preloadedSession` to avoid re-parsing.
- `flush()` writes dirty entries to disk after the scan completes.

**SessionHandle** (in-memory, per-file):
- Wraps a file URL and an optional pre-loaded `SessionData`.
- `session()` returns the cached parse or parses on demand.
- `unifiedLap(index:startTime:endTime:)` returns a cached `UnifiedLap` or computes it on demand.
- Multiple `LapEntry` objects from the same file share the same `SessionHandle` instance.

## Warp/Nudge Alignment Pipeline

When comparing two laps, the reference lap may be slightly misaligned in time (different entry speeds, different lines). The alignment system corrects this:

### Auto-align (`autoAlignReference()`)

Uses damper-based cross-correlation to build a per-sample warp map:

1. **Segment the lap**: Divides by corner boundaries (or into ~10 equal chunks if no corners defined).
2. **Find anchor peaks**: In each segment, finds the largest front-damper peak (average of FL + FR) in the primary lap and searches for a matching peak (same sign, largest magnitude) in the reference lap within a search window.
3. **Median filter**: Rejects outlier matches using a 3-wide median filter on anchor offsets.
4. **Interpolate**: Builds a smooth per-sample warp map using cosine-eased interpolation between anchors. The result is stored as `referenceWarpMap: [Double]?`.

### Manual nudge

`referenceAlignmentOffset: Int` is an additional global sample offset applied on top of the warp map. The user can nudge the reference left/right to fine-tune alignment.

### How it's consumed

Views read `referenceWarpMap` and `referenceAlignmentOffset` to look up the reference value at each sample index. For sample `i` in the primary, the corresponding reference index is `i + warpMap[i] + nudgeOffset`.

## Video Sync Strategies

Video sync maps between session time (seconds from telemetry start) and video time (seconds into video file). Three strategies cascade in priority:

### 1. Absolute Time Sync

Used when: the video file has QuickTime creation timestamps AND the telemetry session has global timestamps (from `FIA_GpsTimeUTC` or `Global Time` channels in PDS files).

How it works:
- `VideoAutoSyncEngine` parses the QuickTime `moov` atom to extract movie/track creation times.
- It tries all integer hour offsets (-14 to +14) to account for timezone differences.
- For each offset, it computes overlap ratio (how much of the telemetry window falls within the video) and lap coverage ratio.
- The best-scoring offset becomes the sync point. Requires score > 0.55 to accept.

### 2. GPS Start/Finish Matching

Used when: the video has embedded GPS telemetry (Pi camera MOV files with a `tmcd` telemetry stream).

How it works:
- `VideoSource.detectLapBoundaries()` finds video times where the car passes within a threshold distance of the start/finish GPS coordinate.
- `VideoAutoSyncEngine.estimateFromGPS()` matches these crossings against telemetry lap boundaries using linear regression.
- It tries all possible alignment offsets between session laps and video crossings.
- The best candidate minimizes RMSE while keeping rate close to 1.0.

### 3. Geometry Fallback

Used when: no absolute timestamps and no GPS data are available.

Generates three candidates:
- Align telemetry start to video time +5s
- Align telemetry end to video end -5s
- Center telemetry window in video

Picks the candidate with the best overlap ratio.

### Persistence

Sync results are stored per-video in `.video-sync/<stem>-<hash>.json`. The hash is an FNV-1a of the normalized file path. Each file stores `point1Session`, `point1Video`, `rate`, and `sessionKey` (to reject stale syncs from different sessions).

### Sync Model

The sync is a two-point linear mapping:

```
videoTime = point1Video + (sessionTime - point1Session) * rate
```

Where `rate` is typically 1.0 (no clock drift). The user can nudge `point1Video` in frame increments for fine adjustment.

## State Management

The app uses a single `@Observable` class as its state root:

```swift
@MainActor
@Observable
final class TelemetryStore { ... }
```

Created as `@State` in the `App` struct and passed to all views. This gives the entire view hierarchy reactive access to:

- **Selection state**: `primary`, `compare`, `corners`, `selectedCornerName`
- **Cursor/viewport**: `cursorFrac` (0-1), `viewStart`, `viewEnd`
- **Alignment**: `referenceAlignmentOffset`, `referenceWarpMap`
- **Video**: `activeVideoURL`, `referenceVideoURL`, `videoSync`
- **Channel config**: `channelEnabled`, `channelWeights`, `channelOrder`, `channelColors`
- **Playback**: `isPlaying` with a 60Hz timer that advances `cursorFrac`

Views use standard SwiftUI bindings. Local `@State` is used for UI-only concerns (layout presets, hover states, drag state).

## File Organization

| File | Responsibility |
|------|----------------|
| `App.swift` | App entry, window definitions, content view with global hotkeys |
| `Store.swift` | `TelemetryStore` + data grouping types (`TrackGroup`, `DateGroup`, `SessionGroup`) |
| `MoTecParser.swift` | Binary parsers for .ld and .pds, channel mapping, resampling, `UnifiedLap` construction |
| `RaceTelemetry.swift` | Parser registry (`RaceTelemetryParser` protocol), dispatches by file extension |
| `SessionMetadataCache.swift` | Disk cache for `SessionSummary`, `SessionHandle` lazy loader |
| `Preferences.swift` | `AppPreferences` model + `PreferencesManager` persistence + Settings UI |
| `Corners.swift` | Corner zone definitions, CSV load/save, auto-generation from braking zones |
| `VideoSource.swift` | `VideoSource` protocol, GPS-based lookup, embedded telemetry extraction from Pi cameras |
| `VideoAutoSync.swift` | Three-strategy video sync engine, QuickTime atom parser |
| `VideoPlayerView.swift` | `VideoSyncState`, `InlineVideoPlayer`, `ReferenceVideoPlayer`, AVPlayer management |
| `StartFinishGPSStore.swift` | Per-track GPS coordinates for start/finish line |
| `SidebarView.swift` | Track/date/session/lap tree navigation |
| `HeaderView.swift` | Lap info bar, channel toggles, alignment controls |
| `TraceView.swift` | Canvas-based telemetry trace rendering |
| `CornerAnalysis.swift` | Per-corner time analysis algorithms |
| `CornerAnalysisView.swift` | Corner comparison table UI |
| `SingleCornerInspector.swift` | Single-lap corner breakdown UI |
| `DriverAnalysis.swift` | Driver profiling from lap history |
| `DriverProfileView.swift` | Driver stats and comparison UI |
| `VideoInspectorView.swift` | Video metadata and sync debugging UI |
| `VideoAudioEnvelope.swift` | Audio RMS extraction for trace overlay |

## Module Dependencies

```
App.swift
  |
  +---> TelemetryStore (Store.swift)
  |       |
  |       +---> SessionMetadataCache + SessionHandle
  |       |       |
  |       |       +---> RaceTelemetry --> MoTecParser
  |       |
  |       +---> Corners (CSV load)
  |       +---> PreferencesManager
  |       +---> VideoAutoSyncEngine
  |       +---> DriverAnalyzer
  |
  +---> Views
          |
          +---> SidebarView (reads tracks, allLaps)
          +---> TraceStackView (reads primary.unified, compare.unified)
          +---> VideoPlayerView (reads videoSync, cursorFrac)
          +---> CornerAnalysis views (reads corners, primary, compare)
          +---> DriverProfileView (reads driverProfiles)
```

## Telemetry Parsers

The app supports two telemetry formats through the `RaceTelemetryParser` protocol:

| Parser | Format | Extension | Source |
|--------|--------|-----------|--------|
| `MoTecTelemetryParser` | MoTeC i2 binary | `.ld` + `.ldx` | MoTeC data logger |
| `PiTelemetryParser` | Pi/Cosworth binary | `.pds` | Pi Toolbox / Cosworth |

Both produce the same `SessionData` output. Channel name mapping uses a priority-ordered alias table in `MoTecParser.channelMappings` with normalized string matching (case-insensitive, stripped of special characters).

## Driver Identification

Drivers are identified from filename tokens. The file stem is scanned for known markers (e.g. `_MJ_` = Mikkel Jensen, `_TL_` = Tobi Lutke). Each driver gets a two-letter tag and a color. Users can override display names via preferences.
