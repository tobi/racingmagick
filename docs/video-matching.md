# Video Matching Baseline

This notes how Racecraft Viewer currently discovers onboards, maps them onto telemetry time, and keeps things usable when the **ClockCrew** workflow hands us re-encoded video without trustworthy metadata. It is the baseline the dedicated matching tool will build on.

> **See also:** [`video-pds-matching.md`](./video-pds-matching.md) defines a deterministic,
> cheap (no-full-parse) ladder for cross-identifying AiM `.MOV` onboards with Cosworth/Pi
> `.pds` files using their embedded hard IDs and absolute GPS clocks. Prefer that over the
> fuzzy filename/size scoring below whenever the original (non-re-encoded) files are present.

## Goals & Constraints
- Show inline video (primary + optional reference) that follows the telemetry cursor/playhead.
- Survive missing or wrong video metadata — ClockCrew often rewraps MOVs days later, so file timestamps drift by hours.
- Require as little manual work as possible, but keep a deterministic escape hatch when auto-alignment fails.
- Persist whatever alignment the engineer dials in so we do not redo work when reopening the same file.

## 1. Finding Candidate Video Files (`TelemetryStore._findVideo`)
1. **Search roots.** Start at the telemetry file directory, plus its parent, plus `video/` and `videos/` subfolders under each. This mirrors how Sebring/Daytona drops are organized.
2. **Exact stem match.** Look for `session.stem + {mp4,mov,mkv,avi,m4v,webm}`. If a file exists return immediately.
3. **Fuzzy token match.** When the stems do not match exactly:
   - Tokenize both filenames on `_ -#.()` and camel-case boundaries, normalize run numbers (`Run001 → run1`), drop long numeric strings (YYMMDDhhmmss).
   - Score +2 for short token matches (`mb`, `ct3`, `seb`), +1 for longer or substring overlaps (`26imsat02` vs `imsa`).
   - Reject anything scoring <3.
4. **Size plausibility.** Estimate expected bytes as `stintSeconds * 1_000_000` (≈1 MB/s). Multiply the token score by `0.5 + 0.5 * min(1, actual/expected)` so truncated captures (common when ClockCrew uploads partial exports) lose against full-length files.
5. **Best score wins.** This yields a deterministic `SessionGroup.videoURL` per telemetry stint, so every lap in the UI references the same discovered video.

## 2. Establishing Time References
### 2.1 Telemetry absolute time
- While parsing `.pds` files we pull `FIA_GpsTimeUTC`/`Global Time` channels into `SessionData.globalTime` along with the sample rate.
- `SessionData.sessionStartUnixTime` becomes `globalTime.first`, and `unixTimeAtSessionTime(t)` interpolates by index (`t * rate`).
- `.ld` MoTeC files rarely expose absolute clocks, so for them only lap-relative time is available.

### 2.2 Video absolute time
`VideoAutoSyncEngine.inspectQuickTimeMetadata` walks the `moov` atom:
- Grabs both `mvhd.creation_time` (file finalized) and the video track’s `tkhd/mdia` creation time (actual capture start when available).
- Reads the `tmcd` timecode track to infer frame rate by looking at the first/last frame counter chunk and dividing by duration. This lets us quantize offsets to the nearest frame.

### 2.3 Why ClockCrew hurts
ClockCrew frequently:
- Re-encodes the MOV after data review, so `creation_time` is when the editor exported, not when the car left pit lane.
- Captures on devices left in EST while telemetry logs UTC, so we see arbitrary ±1–5 hour deltas.
- Clips the start/end to just the lap they care about, giving us partial overlap.
Hence we cannot blindly trust absolute timestamps and must consider multiple offsets + fallback heuristics.

## 3. Auto Alignment Pipeline (`VideoAutoSyncEngine.estimate`)
1. **Session window.** Collect `lapStart = firstLap.startTime`, `lapEnd = lastLap.endTime` (falls back to inferred session duration when laps are missing).
2. **Absolute-time candidates.** When both telemetry `sessionStartUnix` and video creation time exist:
   - Sweep `hourShift = -14…+14` to simulate timezone corrections (`rawVideoStart + hourShift * 3600`).
   - Offset definition: `videoTime = sessionTime + offset`, where `offset = sessionStartUnix - shiftedVideoStart` (how far into the video telemetry time zero occurs).
   - Score = `0.7 * overlapRatio + 0.3 * lapCoverage`, with a small penalty for large timezone shifts and offsets beyond ±2 hours.
3. **Geometry fallbacks.** If absolute candidates are weak (`score ≤ 0.55`) we add three guessers: align telemetry start to video `+5s`, align telemetry end to `videoDuration-5s`, and center telemetry window inside the video.
4. **Select best candidate.** Reject anything with `score ≤ 0.15`. Quantize `point1Video` to the discovered frame step (default 1/30s) to avoid half-frame jitter.
5. **Return result.** `AutoVideoSyncResult` stores `(point1Session=0, point1Video=offset, rate=1)` plus a confidence string used in the UI (`Auto sync (absolute-time, 87%)`).
6. **Application.** When a video loads we attempt auto-estimate. Success sets `VideoSyncState` and seeks; failure opens the manual sync window immediately.

## 4. Manual Two-Point Alignment (`VideoSyncWindow`)
When auto fails — which is common for ClockCrew uploads — the operator sets two anchors:
1. **Step 1: Lap start.** Scrub to where the S/F line crosses at the lap start, press **S/F Start Here**. This stores `(point1Session = lap.startTime, point1Video = scrubberTime)` and switches to step 2.
2. **Step 2: Lap end.** Scrub to the same lap’s finish, press **S/F End Here**. We compute `rate = (videoTime₂ - point1Video) / (lapEnd - point1Session)`. This captures slow drift when the video is time-stretched or if the telemetry logger clock is free-running.
3. **Controls.** Keyboard shortcuts (arrow/comma/period for frame stepping, space to play/pause) and ±10s/±1s buttons make it workable on long stints.
4. **Persistence.** `VideoSyncState.save()` writes `{point1Session, point1Video, rate}` into `.video-sync/<videostem>.json`. Reopening a file reloads it automatically.
5. **Fine trimming.** The transport bar under the inline player exposes ±0.5s nudge buttons for quick adjustments after playback review.

## 5. Using the Alignment
- **Inline player.** `InlineVideoPlayer` keeps the AVPlayer parked at `store.videoSync.videoTime(for: cursorSessionTime)` and follows playback state.
- **Reference video.** When a compare lap also has a video, `ReferenceVideoPlayer` reuses the same mapping to seek into its own AVPlayer, so both clips stay in lock-step.
- **HUD.** Once synced, the HUD overlays gear/speed/pedals sourced from the telemetry sample closest to the cursor fractional distance.

## 6. Persistence & Surfacing
- The sync parameters travel with the video file, not the telemetry file, because ClockCrew routinely reuses the same MOV across multiple exports — we only want to dial it in once per onboard.
- Status messages appear next to the transport (“Auto sync (absolute-time, 82%)”) to show how the mapping was produced.
- The `Set Sync…` toolbar button/`⌘V` panel always launches the manual window so engineers can re-run alignment even after auto success (e.g., when spotting slight drift mid-stint).

## 7. Known Failure Modes & Mitigations
| Issue | Symptoms | Current Mitigation |
|-------|----------|--------------------|
| ClockCrew rewrap changed creation time | Auto picks offset off by whole days | Hour-sweep across ±14h, penalize huge offsets but still allow them when overlap is strong |
| Video trimmed to highlight lap only | Telemetry extends beyond video, fallback picks wrong end | Geometry fallbacks (start, end, center) try to keep telemetry within the clip; manual two-point remains final arbiter |
| Logger clock drift / non-1.0 rate | Playback slowly drifts out of sync | Manual step 2 computes `rate` from lap span; we persist rate so both auto-seek and playback honor it |
| No matching filename | No video shown | Fuzzy token + size scoring picks best guess; still exposes manual toggle for the user to load another file |

## 8. Preferred path: embedded IDs + GPS (when originals are present)
The fuzzy filename/size scoring above is now the **fallback**, not the primary path.
When camera-original files are available we identify and align deterministically:

- **Cross-identification** from cheap embedded IDs on both sides, no full parse — see
  [`video-pds-matching.md`](./video-pds-matching.md).
- **AiM SmartyCam `.MOV`** onboards carry embedded ~4 Hz GPS + an absolute GPS-time-of-week
  clock that survives renames — decoded in `src/video-extract.ts`, format in
  [`aim_smartycam_video.md`](./aim_smartycam_video.md). This is the trusted-GPS path that
  lets us skip the heuristics entirely.

The fuzzy baseline only applies to re-encoded `.mp4` deliveries whose data track and
metadata were stripped, where filename tokens + lap-interval correlation are all that remain.
The one remaining hook worth building is surfacing `_findVideo`'s candidate scorecard so a
human can override creative ClockCrew filenames.
