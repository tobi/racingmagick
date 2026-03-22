# racingmagick

Universal motorsport telemetry parser. MoTeC, Pi/Cosworth, VBOX → normalized `Session/Lap/ChannelMatrix`.

Like ImageMagick, but for telemetry formats.

## Formats

| Format | Extension | Source |
|--------|-----------|--------|
| MoTeC i2 | `.ld` + `.ldx` | MoTeC loggers, iRacing, ACC |
| Pi/Cosworth | `.pds` | Pi Sigma/Delta/Omega, Cosworth ICD |
| VBOX | `.vbo` | Racelogic VBOX, ERA telemetry |

## Usage

```typescript
import { parseFile } from 'racingmagick';

const session = await parseFile('race.ld');

console.log(session.driver, session.track, session.lapCount);

for (const lap of session.timedLaps()) {
  console.log(lap.displayLabel, lap.lapTime, 'ms');

  const speed = lap.channel('speed');    // Float64Array, zero-copy
  const sample = lap.at(0.5);           // interpolated at 50% of track
  console.log(sample.speed, sample.throttle, sample.brakePressure);
}
```

## Architecture

- **ChannelMatrix** — flat `Float64Array[]` at constant Hz, shared by all laps
- **LapSample** — zero-allocation view into the matrix at a sample index
- **Lap** — range `[startIdx, endIdx)` with track-position interpolation
- **Session** — laps + metadata + channel availability + video attachment
- **Channel priorities** — each canonical channel has an ordered alias list with inline unit transforms

## Tests

```bash
npm test           # 461 tests, 13 files
```

## Inspector

```bash
cd web && npx tsx server.mjs
# → http://localhost:3456
```

## Docs

- `docs/motec_format.md` — MoTeC .ld binary format specification
- `docs/pds_format.md` — Pi/Cosworth .pds binary format specification
- `docs/VBO_FORMAT.md` — VBOX .vbo text format specification
- `docs/video_sync.md` — Video synchronization strategies
- `docs/video-matching.md` — Video file discovery and alignment
