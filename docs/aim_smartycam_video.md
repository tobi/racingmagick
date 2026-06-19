# AiM SmartyCam Embedded Telemetry (reverse-engineered)

AiM **SmartyCam GP HD** onboard cameras embed a GPS + telemetry stream **inside the
`.MOV` file** as a third track that masquerades as a second audio track. RacecraftViewer
can decode this directly, giving us the "Gold Standard" embedded-GPS video sync (see
`video_sync.md`) for AiM footage — not just GoPro.

> ⚠️ The data only survives in the **original `.MOV`**. Re-encoded `.mp4`
> deliveries (ClockCrew rewraps to HEVC/AAC) **drop this track entirely**. Always keep
> the camera-original MOV if you want GPS-perfect sync.

## How to recognize it

```
ffprobe -v error -show_entries stream=index,codec_type \
  -show_entries stream_tags=handler_name -of csv=p=0 file.MOV
0,video,VideoHandler
1,audio,SoundHandler
2,audio,TmcdHandler      <-- the embedded data track
```

The third track:
- handler name `TmcdHandler`, but the `hdlr` component subtype is `free` (not `tmcd`).
- declared as **PCM `sowt`, 48000 Hz, 16-bit, mono** → constant **96000 bytes/s**.
- constant RMS (~18500) and full byte entropy in the payload region — it is a *data*
  stream padded to a fixed bitrate, not audio.

The `moov/udta` also carries an XML block identifying the device:

```xml
<aim_meta_data version="0.0.0">
  <generic_info>
    <p n="track_name">24HeuresVar2</p>
    <p n="track_lat0">479498464</p>   <!-- origin lat * 1e7 -->
    <p n="track_lon0">2074489</p>     <!-- origin lon * 1e7 -->
    <p n="date">11/06/2026</p>
    <p n="hour">14:44.07</p>          <!-- local capture start -->
    ...
  </generic_info>
  <hw_info>
    <p n="logo">AIM_SC2_GP</p>
    <p n="meccaniche">SmartyGP_HD</p>
    <p n="hwserial">4107164</p>
  </hw_info>
</aim_meta_data>
```

## Stream framing

The PCM track is a sequence of fixed **19200-byte frames**:

```
19200 bytes ÷ 96000 bytes/s = 0.200 s  →  5 frames/second
```

`videoTime(frame) = frameIndex * 0.2` seconds.

Each frame begins with a ~128-byte **little-endian** header of `int32`/`float32`
telemetry fields; the remainder is an opaque (scrambled/padded) payload.

### Decoded header fields (offsets within a frame)

| Offset | Type | Meaning | Notes |
|-------:|------|---------|-------|
| 0  | int32 | frame counter | +5 per frame |
| 8  | int32 | millisecond counter | +200 per frame |
| 16 | int32 | **GPS latitude** | degrees × 1e7 |
| 24 | int32 | **GPS longitude** | degrees × 1e7 |
| 48 | int32 | **GPS time-of-week (ms)** | advances 250 ms when GPS updates |
| 104| int32 | speed-correlated channel | corr ≈ 0.5 with GPS speed |
| 112| float32 | sensor (≈0–15) | sat count / HDOP-like |

### GPS rate

The camera GPS fixes at **4 Hz (250 ms)** while the container frames at 5 Hz, so every
5th frame repeats the previous fix (`off48` delta = 0). Dedupe by `off48` to recover the
true 4 Hz track; decimate to 1 Hz if a coarse channel is wanted.

`off48` is **GPS time-of-week in milliseconds**. Example: `391469750 ms` →
108.74 h into the GPS week → Thursday 12:44 UTC, which is 14:44 CEST — exactly matching
the `<hour>14:44.07</hour>` metadata. Combined with the `<date>` (→ GPS week number) this
yields an **absolute UTC timestamp per frame**, enabling drift-free alignment to
`FIA_GpsTimeUTC` / `Global Time` in the telemetry even when the container `creation_time`
was rewritten by a re-encode.

### Validation

Decoded tracks for Le Mans 2026 FP3 stayed within the circuit bounding box
(47.909–47.967 °N, 0.194–0.258 °E) with physically plausible 4 Hz speeds and only
sporadic multipath outliers (handled by the standard speed-sanity / haversine filter
described in `PRD.md`).
