# Efficiently Matching Video ↔ `.pds` (without parsing the whole file)

> Why this exists: historically we matched onboards to telemetry with container
> `creation_time` + fuzzy filename/size scoring. That **never worked reliably** —
> re-encoding (ClockCrew) rewrites `creation_time`, trims clips, and renames files,
> so the heuristics drifted by hours and picked wrong runs.
>
> Both AiM SmartyCam `.MOV` and Cosworth/Pi `.pds` carry **hard identifiers and
> absolute clocks** that we can read from a few KB at the head/tail of each file.
> This doc defines the cheap signals and the deterministic matching ladder.

## Cheap signals on each side

### AiM SmartyCam `.MOV` (read: filename + `moov` tail + first data frame)

| Signal | Where | Cost | Notes |
|--------|-------|------|-------|
| Filename tokens | name | free | `26WEC01_R01_LM_FP3_KE_Run1` → series/round, track, **session**, **driver**, **run** |
| `aim_meta_data` XML | `moov/udta` (file tail, ≤100 KB) | cheap | `date`, `hour` (**local**), `hwserial` (camera id), `track_name`, `track_lat0/lon0` |
| **GPS time-of-week** | first 19200-byte data frame (off 48) | cheap | **absolute UTC** clock — survives as long as the original MOV is kept |
| First GPS lat/lon | first data frame (off 16/24) | cheap | geometry cross-check |
| `creation_time` | `mvhd`/`tkhd` | free | **untrusted** — rewritten by re-encodes |

> ⚠️ Re-encoded `.mp4` deliveries drop the data track (no GPS-ToW / lat-lon) **and**
> usually the `aim_meta_data`. For those, only filename tokens remain — see fallback.

### Cosworth/Pi `.pds` (read: filename + header + one channel's first chunk)

| Signal | Where | Cost | Notes |
|--------|-------|------|-------|
| Filename tokens | name | free | `260611144234_26WEC01_R01_LM_FP3_Run001_KE_Car14_#438` → datetime (**local**), series, track, **session**, **run**, **driver**, **car** |
| Device metadata string | UTF-16LE near head (~byte 15 000, first 64 KB) | cheap | `Device Type: MQ12Di_LMP2; … Serial Number: 438; Toolset …; Metadata Version …` — **serial == car number** |
| Channel list | definitions block (first ~64 KB) | cheap | presence of `FIA_GpsTimeUTC`, `Global Time`, `FIA_GpsLatN`, `FIA_GpsLongE` |
| **Absolute UTC start** | `Global Time` / `FIA_GpsTimeUTC` first chunk | cheap | parse directory @`0x80` → defs → that channel's **first chunk only** (few hundred KB), no full decode |
| First GPS lat/lon | `FIA_GpsLatN/LongE` first chunk | cheap | geometry cross-check |

## Matching ladder (cheap → expensive, stop at first confident hit)

1. **Token identity (deterministic).** Tokenize both filenames; require equality on
   `series/round` + `track` + `session` + `driver` + `car`, and a matching **run number**.
   - Normalize runs: video `Run1` → `1`; PDS `Run001`/`Run002A`/`Run002B` → `1`, `2a`, `2b`.
     Keep the A/B suffix — a single "Run 2" video may map to multiple PDS segments.
   - `car`: video folder/clip `Car14_#438` ↔ PDS token `Car14_#438`.
2. **Hardware cross-check (rejects false positives).** PDS `Serial Number` (e.g. `438`)
   must equal the car number from the PDS car token / video folder. Confirms you matched
   the right car even when a session has two cars logging identical filenames.
3. **Time gate.** Both filename clocks are **local** (CEST here): PDS `260611144234`
   (14:42:34) vs AiM `<hour>14:44.07</hour>`. Require |Δ| within a few minutes (logger
   starts before the camera). This disambiguates multiple runs by the same driver.
4. **Absolute-UTC confirmation (drift-free, survives renames).** Compare the video's
   **GPS time-of-week** (→ UTC, combined with `<date>`) against the PDS
   `FIA_GpsTimeUTC`/`Global Time` first sample. Overlap of the two [start,end] windows is
   the strongest, re-encode-proof signal. (Verified: video first fix 12:44 UTC ↔ PDS
   `260611144234` local = 12:42 UTC, with PDS logging starting ~1.5 min earlier.)
5. **Geometry tie-break.** If two candidates still tie, compare first GPS lat/lon
   (both within ~tens of metres at pit-out) — already cheap from steps above.

### Fallback for re-encoded `.mp4` (no embedded GPS/metadata)

Only filename tokens survive. Use steps 1–2 for identity; for *sync* fall back to the
existing lap-interval cross-correlation (`alignLapCrossings`) since absolute time is gone.
This is exactly the case the old pipeline got stuck on — flag it in the UI as low
confidence and prefer the original `.MOV` when available.

## Why this is fast

None of the steps decode the full telemetry. The PDS path reads the directory
(`0x80`), the definitions block, and **one channel's first chunk** — a few hundred KB out
of 20–80 MB. The video path reads the filename, the `moov` tail, and the **first 19200-byte
frame**. Matching a whole session folder is I/O-trivial.

See also: [`aim_smartycam_video.md`](./aim_smartycam_video.md) (video GPS format),
[`pds_format.md`](./pds_format.md) (directory/channel/chunk layout),
[`video_sync.md`](./video_sync.md) (alignment strategies).
