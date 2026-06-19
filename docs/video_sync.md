# Video and Telemetry Synchronization Guide

When importing `.pds` or `.ld` telemetry files alongside video (e.g., `.MOV` or `.MP4`), RacecraftViewer provides multiple strategies to synchronize the telemetry traces with the video playback. 

To avoid the tedious process of manually aligning data frames to video frames, we strongly recommend configuring your logging systems to support automatic synchronization.

The auto-sync engine tries multiple methods in descending order of quality and confidence. Here is how to configure your data and cameras for the best possible experience.

---

### 1. The Gold Standard: Embedded Video GPS Matching (Highest Confidence)
**How it works:** The engine extracts GPS telemetry embedded directly within the video file (supported by modern GoPros, Garmin, etc.) and compares the vehicle's Start/Finish line crossing times to the GPS coordinates in your telemetry file. This provides frame-perfect, real-world synchronization regardless of camera drift or when the camera was turned on.

> **AiM SmartyCam support:** AiM SmartyCam GP HD onboards embed a **4 Hz GPS +
> absolute GPS-time-of-week clock** inside the `.MOV` as a PCM data track. The
> engine decodes this directly (5 Hz frames, deduped to 4 Hz fixes) — see
> [`aim_smartycam_video.md`](./aim_smartycam_video.md). Note: keep the
> camera-original `.MOV`; re-encoded `.mp4` deliveries drop the GPS track.

**What you need:**
* **Camera:** A camera recording high-Hz GPS data directly into the video file (e.g., GoPro metadata track, or AiM SmartyCam `.MOV`).
* **Telemetry Data:** Must export high-resolution GPS channels. 
  * Ensure **`FIA_GpsLatN`** (or `gps latitude`) and **`FIA_GpsLongE`** (or `gps longitude`) are exported.
* **Lap Data:** The telemetry file must have lap times or distance splits to establish where the S/F line actually is. Exporting **`Previous Lap Time`** or **`lap_beacon`** guarantees this works flawlessly.

### 2. Absolute Time Sync (UTC / Global Time)
**How it works:** If the video does not contain a continuous GPS track, the engine looks at the absolute "Wall Clock" time. It compares the QuickTime creation timestamp (or timecode `tmcd` track) of the video file to the global UTC timestamps recorded in your telemetry. The app automatically scans across timezones to find the correct overlap.

**What you need:**
* **Camera:** Must embed accurate Real-Time Clock (RTC) creation timestamps or a timecode track into the file metadata (Standard for most action cams and professional recording rigs like VBOX, provided their internal clocks are synced via GPS or NTP).
* **Telemetry Data:** You **must** export the global UTC timestamp.
  * We strongly recommend exporting **`FIA_GpsTimeUTC`**. 
  * If that is unavailable, **`Global Time`** or **`System Time High`** will be used as a fallback.
* *Note: Ensure your camera's internal clock is reasonably accurate, or the sync engine might reject the offset as implausible if it differs by more than a few hours from the telemetry date.*

### 3. Fallback Geometry Sync (Assumption-Based)
**How it works:** If neither GPS nor absolute UTC time can be correlated (e.g., missing channels, or mismatched dates), the engine will attempt to guess the alignment based on the duration of the recording. It tries scenarios like "the telemetry started 5 seconds after the video started" or "the video perfectly centers the telemetry."

**Why to avoid it:** This method has low confidence and will frequently guess wrong if the camera was left running in the pits for extended periods before or after the run. You will likely have to manually nudge the sync offset in the app.

---

### Summary Checklist for the Race Engineer
To guarantee seamless, zero-click video synchronization in RacecraftViewer, please ensure the following channels are **always** included in your `.pds` or `.ld` exports:

1. **`FIA_GpsTimeUTC`** (Critical for UTC time alignment)
2. **`FIA_GpsLatN`** & **`FIA_GpsLongE`** (Critical for GPS track-matching and fallback S/F line detection)
3. **`Previous Lap Time`** (Critical for defining accurate lap boundaries natively without app-side recalculation)

As long as these are present alongside standard inputs (Speed, Throttle, Brake, Steering), the app will handle the rest!
