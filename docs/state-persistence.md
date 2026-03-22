# State Persistence

RacecraftViewer persists user state across six file locations. All paths are currently hardcoded relative to the project directory.

## Persistence Locations

| File | Format | Purpose |
|------|--------|---------|
| `.viewer-state.json` | JSON | Last selected lap, skipped laps |
| `.preferences.json` | JSON | Session directories, corners directory, driver name overrides |
| `.video-sync/<stem>-<hash>.json` | JSON (per video) | Video sync anchor points |
| `.sf-line-gps.json` | JSON | Start/finish GPS coordinates per track |
| `.cache/session-metadata.v2.json` | JSON | Session metadata cache |
| `corners/*.csv` | CSV (external dir) | Corner zone definitions per track |

## .viewer-state.json

**Location**: `~/src/tries/2026-02-20-motec-parser/RacecraftViewer/.viewer-state.json`

**Purpose**: Remembers which lap was selected when the app last closed, so it restores to the same view on relaunch.

**Written by**: `TelemetryStore.saveState()` -- called from `selectPrimary()`, `selectCompare()`, and `toggleSkip()`.

**Read by**: `TelemetryStore.restoreState()` -- called at the end of `loadMultiple()` after all sessions are loaded.

**Schema**:

```json
{
  "primaryLapId": "260224000716_SEB_MJ_LMP2_Run001_L3",
  "compareLapId": null,
  "skippedLapIds": ["260224000716_SEB_MJ_LMP2_Run001_L0"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `primaryLapId` | `String?` | ID of the display lap (format: `<fileStem>_L<index>`) |
| `compareLapId` | `String?` | ID of the reference lap. Currently always saved as `nil` (compare state is not persisted). |
| `skippedLapIds` | `[String]?` | Lap IDs excluded from "best lap" selection (e.g., outlaps, aborted laps) |

**Restore behavior**: If the saved primary lap ID matches a loaded lap, it is selected. Otherwise, the fastest lap across all tracks is auto-selected. Compare is always restored as `nil`.

## .preferences.json

**Location**: `~/src/tries/2026-02-20-motec-parser/RacecraftViewer/.preferences.json`

**Purpose**: Stores user-configured session directories, the corners directory path, and custom driver name overrides.

**Written by**: `PreferencesManager.save()` -- called from the Settings view when directories change, and from `TelemetryStore.renameDriver()`.

**Read by**: `PreferencesManager.load()` -- called at app startup in `App.body.task{}`, and when `TelemetryStore` initializes `driverNameOverrides`.

**Schema**:

```json
{
  "sessionDirectories": [
    "/Users/tobi/src/tries/2026-02-20-motec-parser/motec-parser/sessions"
  ],
  "cornersDirectory": "/Users/tobi/src/tries/2025-12-30-tobi-ac-tracer/corners",
  "driverNames": {
    "mj": "Mikkel",
    "tl": ""
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sessionDirectories` | `[String]` | Absolute paths to directories containing `.ld` / `.pds` files. Scanned recursively. |
| `cornersDirectory` | `String` | Absolute path to the directory containing corner CSV files. |
| `driverNames` | `[String: String]` | Map from driver tag (e.g., `"mj"`) to custom display name. Empty string or missing key = use default name from `driverTags`. |

**Default behavior**: If the file is missing or unreadable, a default `AppPreferences` is returned with a single hardcoded session directory and the default corners directory.

## .video-sync/<stem>-<hash>.json

**Location**: `~/src/tries/2026-02-20-motec-parser/RacecraftViewer/.video-sync/` directory. One file per video.

**Filename convention**: `<videoStem>-<pathHash>.json` where `pathHash` is an FNV-1a hash of the normalized file path (16 hex characters). This avoids collisions when multiple videos share the same filename in different directories.

**Purpose**: Persists the video sync calibration (anchor points and rate) for each video file, so sync only needs to be computed or manually set once.

**Written by**: `VideoSyncState.save()` -- called from `TelemetryStore.applyVideoSync()`, `saveVideoSyncNow()`, and the video sync setup window.

**Read by**: `VideoSyncState.loadSaved(currentSessionKey:)` -- called when a video is loaded for playback.

**Schema**:

```json
{
  "point1Session": 67.34,
  "point1Video": 12.567,
  "rate": 1.0,
  "sessionKey": "260224000716_SEB_MJ_LMP2_Run001"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `point1Session` | `Double` | Session time (seconds from telemetry start) of the first sync anchor |
| `point1Video` | `Double` | Video time (seconds into video) of the first sync anchor |
| `rate` | `Double` | Playback rate multiplier. Typically 1.0. Maps session time deltas to video time deltas. |
| `sessionKey` | `String?` | File stem of the telemetry session this sync was calibrated against |

**Sync model**: `videoTime = point1Video + (sessionTime - point1Session) * rate`

**Staleness detection**: When loading a saved sync, the `sessionKey` is compared against the current telemetry session. If they differ, the saved sync is rejected (returns `false`). This prevents stale sync data from being applied when a video is reused with a different session.

**Clearing**: `VideoSyncState.clearSaved()` deletes the file. Used when the user wants to re-sync from scratch.

## .sf-line-gps.json

**Location**: `~/src/tries/2026-02-20-motec-parser/RacecraftViewer/.sf-line-gps.json`

**Purpose**: Stores the GPS coordinates of the start/finish line for each track. Used by the GPS-based video sync strategy to detect lap boundary crossings in video GPS data.

**Written by**: `StartFinishGPSStore.save(_:track:)` -- called when GPS sync detects or the user provides S/F coordinates.

**Read by**: `StartFinishGPSStore.load(track:)` -- called during GPS video sync.

**Schema**:

```json
{
  "sebring": { "lat": 27.4543, "lon": -81.3485 },
  "daytona": { "lat": 29.1855, "lon": -81.0705 }
}
```

The dictionary key is a normalized track name: lowercased, with spaces, hyphens, and underscores stripped.

| Field | Type | Description |
|-------|------|-------------|
| `lat` | `Double` | Latitude in degrees (positive = North) |
| `lon` | `Double` | Longitude in degrees (positive = East) |

**Key normalization**: `track.lowercased().replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "-", with: "").replacingOccurrences(of: "_", with: "")`

## .cache/session-metadata.v2.json

**Location**: `~/src/tries/2026-02-20-motec-parser/RacecraftViewer/.cache/session-metadata.v2.json`

**Purpose**: Caches parsed session metadata (laps, header info, per-corner times) to avoid re-parsing telemetry files on every app launch. Parsing a .pds file takes 100-500ms; the cache reduces this to a JSON decode.

**Written by**: `SessionMetadataCache.flush()` -- called via `defer` at the end of `_loadSyncMultiple()`. Only writes if `dirty` flag is set (i.e., at least one cache miss occurred).

**Read by**: `SessionMetadataCache.summary(for:)` -- called for each telemetry file during the scan.

**Schema**:

```json
{
  "version": 2,
  "entries": {
    "/path/to/session.pds": {
      "signature": {
        "fileSize": 52428800,
        "modifiedAt": 1708761600.0
      },
      "summary": {
        "filePath": "/path/to/session.pds",
        "fileStem": "260224000716_SEB_MJ_LMP2_Run001",
        "parser": "pds",
        "headerDate": "24/02/2026",
        "headerVenue": "Sebring",
        "headerDriver": "Mikkel Jensen",
        "headerVehicle": "LMP2",
        "laps": [
          {
            "index": 0,
            "startTime": 0.0,
            "endTime": 67.34,
            "timeMs": 67340.0,
            "cornerTimes": [
              { "name": "Turn 1", "timeSeconds": 3.42 }
            ]
          }
        ]
      }
    }
  }
}
```

### Cache Invalidation

Each entry is keyed by the file's absolute path and includes a `FileSignature`:

| Field | Type | Description |
|-------|------|-------------|
| `fileSize` | `UInt64` | File size in bytes |
| `modifiedAt` | `TimeInterval` | File modification timestamp (seconds since Unix epoch) |

On access, the current file's signature is compared against the cached signature. If either value differs, the cache entry is considered stale and the file is re-parsed. This handles:
- File content changes (size change)
- File re-exports (modification date change)
- File replacement (both change)

### Version field

The `version` field is checked on load. Only version `2` is accepted. If the file is missing, unreadable, or has a different version, the cache starts empty.

### Corner times

When a cache miss triggers a full parse, corner times are computed for each lap if corner definitions exist for the track. These are stored in `cornerTimes` within each lap entry, avoiding the need to re-unify channels just to compute corner analysis.

## corners/*.csv

**Location**: Configurable via `preferences.cornersDirectory`. Default: `~/src/tries/2025-12-30-tobi-ac-tracer/corners/`

**Purpose**: Define named corner zones for each track as normalized lap fractions. Used for corner-by-corner analysis and segment-based warp alignment.

**Filename convention**: One CSV per track. The file stem is matched against the track name using fuzzy substring matching (lowercased, underscores stripped). A `trackAliases` dictionary maps common names to specific file stems (e.g., `"daytona"` -> `"ier_daytona"`).

**Format**:

```csv
name,start,end
Turn 1,0.023000,0.078000
Turn 3,0.125000,0.198000
Turn 5,0.241000,0.302000
```

| Column | Type | Description |
|--------|------|-------------|
| `name` | String | Corner name (e.g., "Turn 1", "Sunset Bend") |
| `start` | Double | Start of corner zone as a fraction of lap distance (0.0 - 1.0) |
| `end` | Double | End of corner zone as a fraction of lap distance (0.0 - 1.0) |

**Loading**: `Corners.load(track:)` first checks `trackAliases`, then falls back to scanning the corners directory for a CSV whose stem fuzzy-matches the track name.

**Writing**: `Corners.save(track:corners:)` writes back to the matching CSV file. `Corners.saveNew(track:corners:)` creates a new file for auto-generated corners.

**Auto-generation**: `Corners.generate(from:track:)` can create corner definitions from braking zones in a lap. It finds sustained braking events (>15% of peak pressure), merges close zones, and extends each to include approach and exit. The generated zones are named "Turn 1", "Turn 2", etc.

## Lifecycle Summary

### On app launch

1. `PreferencesManager.load()` reads `.preferences.json` for session directories.
2. `TelemetryStore.loadMultiple()` scans directories, checking `SessionMetadataCache` for each file.
3. Cache hits return `SessionSummary` directly; misses trigger a full parse and cache update.
4. `SessionMetadataCache.flush()` writes updated cache to disk.
5. `TelemetryStore.restoreState()` reads `.viewer-state.json` to restore the last selected lap.
6. `Corners.load(track:)` reads the appropriate CSV for the selected track.

### On lap selection

1. `TelemetryStore.selectPrimary()` updates `primary`, loads corners, resets alignment.
2. `saveState()` writes the new selection to `.viewer-state.json`.
3. If a video was linked, `VideoSyncState.loadSaved()` checks for a cached sync in `.video-sync/`.

### On video sync

1. Auto-sync: `VideoAutoSyncEngine.estimate()` or `estimateFromGPS()` computes sync parameters.
2. `TelemetryStore.applyVideoSync()` stores the result in `videoSync` and calls `videoSync.save()`.
3. The sync is persisted to `.video-sync/<stem>-<hash>.json`.
4. Manual nudge: `nudgeVideoSync()` adjusts `point1Video` and writes on explicit save.
