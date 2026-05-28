# racingmagick

[Documentation](https://pages.tobi.lutke.com/racingmagick/) · [GitHub](https://github.com/tobi/racingmagick)

Universal motorsport telemetry parser and query layer.

**MoTeC i2 (`.ld` + `.ldx`), Pi/Cosworth (`.pds`), and VBOX (`.vbo`) all become one normalized `Session → Lap → ChannelMatrix → LapSample` model.**

Think ImageMagick, but for racing telemetry.

```ts
import { parseFile } from 'racingmagick';

const session = await parseFile('race.ld');

console.log(session.driver, session.vehicle, session.track);
console.log(session.format, session.lapCount, session.sampleRate, 'Hz');

const fastest = session.fastestLap();
if (fastest) {
  const speed = fastest.channelOrThrow('speed');       // Float64Array, km/h, zero-copy view
  const apex = fastest.at(0.42);                       // interpolated by normalized track position

  console.log('fastest lap', fastest.displayLabel, fastest.lapTime, 'ms');
  console.log('apex speed', apex.speed, 'km/h');
  console.log('throttle', apex.throttle);              // normalized 0..1 ratio
  console.log('brake pressure', apex.brakePressure);   // bar, or null if not recorded
}
```

## Why this exists

Motorsport data is fragmented:

- the same channel has different names in different systems (`Corr Speed`, `Vehicle_Speed`, `Speed`, `GPS Speed`)
- the same physical quantity appears in different units (`m/s`, `mph`, `km/h`, `psi`, `kPa`, `rad`, `deg`)
- logs use different sample rates and lap-boundary representations
- optional data varies wildly by logger, car, and export path

`racingmagick` normalizes all of that so analysis code can ask for canonical channels like `speed`, `throttle`, `brakePressure`, `gpsLat`, `wheelSpeedFL`, and get consistent units and access patterns.

## Supported formats

| Format | Extension | Source | Status |
|---|---:|---|---|
| MoTeC i2 | `.ld` + optional `.ldx` | MoTeC loggers, sim exports | supported |
| Pi/Cosworth | `.pds` | Pi Sigma/Delta/Omega, Cosworth ICD/export | supported |
| VBOX | `.vbo` | Racelogic VBOX, ERA telemetry | supported |

## Install / develop

This repo uses **pnpm**.

```bash
pnpm install
pnpm test
```

Useful scripts:

```bash
pnpm test           # unit + representative real-fixture abstraction tests
pnpm test:fixtures  # full fixture suite, requires all large fixtures
pnpm type-check
pnpm build
```

## The data model

```text
Session
  metadata: driver, vehicle, track, date, format, warnings
  matrix: ChannelMatrix                 # all normalized channels, constant sample rate
  laps: Lap[]                           # ranges into the shared matrix

Lap
  startIdx/endIdx into Session.matrix
  metadata: lapTime, kind, sectors, totalDistance
  methods: channel(), at(), atTime(), channelAtPositions(), delta()

ChannelMatrix
  Float64Array[] rows, one row per normalized channel
  first rows always: time, distance, trackPosition, speed, throttle

LapSample
  zero-allocation view of one/interpolated sample
  typed getters: speed, throttle, rpm, brakePressure, gpsLat, ...
  generic getter: get(channelName)
```

The first five canonical rows are always allocated and populated:

| Channel | Unit | Meaning |
|---|---:|---|
| `time` | `s` | session elapsed time |
| `distance` | `m` | cumulative distance; integrated from speed if missing |
| `trackPosition` | `ratio` | normalized 0..1 position around the session/lap |
| `speed` | `km/h` | vehicle/reference speed |
| `throttle` | `ratio` | driver throttle demand, normalized 0..1 |

Optional channels are exposed when present and return `null` on `LapSample` when missing.

## How do I query what data is available?

Start from the session:

```ts
const session = await parseFile('race.vbo');

// List normalized channel names in storage order.
console.log(session.channelNames());

// Rich metadata for each channel: name, index, normalized unit, sample rate, count.
console.table(session.channelsInfo());

// Fast availability flags for common groups.
console.log(session.has.gps);            // true if gpsLat + gpsLon exist
console.log(session.has.brakePressure);  // true if front brake pressure exists
console.log(session.has.wheelSpeeds);    // true only when all four corners exist
console.log(session.has.tireTemps);

// Single channel metadata.
console.log(session.channelInfo('speed'));
// { name: 'speed', index: 3, unit: 'km/h', sampleRate: 100, sampleCount: 123456, required: true }
```

### Read a whole channel

```ts
const speed = session.channelOrThrow('speed'); // Float64Array in km/h
const rpm = session.channel('rpm');            // Float64Array | null

if (rpm) {
  const maxRpm = Math.max(...rpm);
  console.log(maxRpm);
}
```

`channel()` returns `null` if the channel was not recorded. `channelOrThrow()` is useful for required channels or tests.

### Query by lap

```ts
const lap = session.fastestLap() ?? session.lap(0);

const lapSpeed = lap.channelOrThrow('speed');  // subarray view, zero-copy
const brake = lap.channel('brakePressure');    // bar, or null

console.log(lap.displayLabel, lap.lapTime, lap.totalDistance);
console.log(lap.channelInfo('speed'));
```

### Query an interpolated sample

`lap.at(position)` queries by normalized track position (`0.0` start line, `1.0` end of lap):

```ts
const s = lap.at(0.5);

console.log(s.time);          // seconds
console.log(s.speed);         // km/h
console.log(s.throttle);      // 0..1
console.log(s.brakePressure); // bar | null
console.log(s.gpsLat);        // decimal degrees | null

// Generic channel API for optional or custom channels.
console.log(s.get('wheelSpeedFL'));
console.log(s.getOr('rpm', 0));
console.log(s.toObject(['speed', 'throttle', 'rpm', 'brakePressure']));
```

### Resample for plotting or comparisons

```ts
// One channel over 1000 equal track-position points.
const speedTrace = lap.channelAtPositions('speed', 1000);

// All typed samples at 50 positions.
const samples = lap.resample(50);

// Original-rate slice between 20% and 35% of the lap.
const corner = lap.slice(0.20, 0.35);
for (const sample of corner) {
  console.log(sample.speed, sample.throttle);
}
```

### Compare laps

```ts
const [a, b] = session.timedLaps();
if (a && b) {
  const delta = a.delta(b);

  console.log(delta.totalDelta, 'ms');       // positive means a is slower
  console.log(delta.deltaAt(0.5), 'ms');
  console.log(delta.deltaTrace(1000));       // Float64Array, ms over track position
}
```

### GPS helpers

```ts
if (lap.has.gps) {
  const trace = lap.gpsTrace();
  const bounds = lap.gpsBounds();
  console.log(trace?.[0], bounds);
}
```

## Canonical channels and units

The resolver maps vendor/raw channel names into canonical names, then normalizes units.

```ts
import {
  canonicalChannelNames,
  getChannelDefinition,
  getCanonicalUnit,
  resolveChannelName,
} from 'racingmagick';

console.log(canonicalChannelNames());
console.log(getCanonicalUnit('brakePressure')); // 'bar'
console.log(resolveChannelName('Brake_Pressure_Front')); // 'brakePressure'
console.log(getChannelDefinition('speed')?.aliases);
```

Examples of canonical units:

| Canonical channel | Normalized unit |
|---|---:|
| `speed`, `gpsSpeed`, `wheelSpeedFL` | `km/h` |
| `throttle`, `brakePedal`, `clutchPedal` | `ratio` |
| `distance`, `gpsAlt` | `m` |
| `brakePressure`, `tirePressureFL` | `bar` |
| `steering`, `heading`, `tireSlipAngleFL` | `deg` |
| `yawRate` | `deg/s` |
| `gLong`, `gLat` | `g` |
| `tireTempFL` | `°C` |
| `damperFL` | `mm` |
| `tireLoadFL` | `N` |

See [`docs/channels-and-units.md`](docs/channels-and-units.md) for the channel catalog and normalization behavior.

## Custom/unrecognized channels

Unrecognized source channels are preserved as custom channels with sanitized lowercase names. If a raw custom channel collides with a canonical name, it is prefixed to avoid ambiguity.

```ts
for (const info of session.channelsInfo()) {
  if (info.unit === null) {
    console.log('custom or unknown unit channel:', info.name);
  }
}
```

## Warnings and data quality

Parsing may succeed with warnings. Examples:

- `distance-channel-missing` — distance was integrated from speed
- `throttle-fallback` — post-TC throttle was used because driver throttle was absent
- `coordinate-conversion` — GPS coordinates were converted to decimal degrees
- `gps-quality-poor` — GPS quality was too poor for position source

```ts
for (const warning of session.warnings) {
  console.warn(warning.code, warning.message, warning.channel ?? '');
}
```

## Export

Sessions can be exported as VBO:

```ts
await session.saveVbo('./out', 'converted.vbo');
await session.saveVboAndVideo('./out', 'converted.vbo');
```

## Inspector

```bash
cd examples/inspector
pnpm install
pnpm dev
# http://localhost:3456
```

## Documentation

Start here:

- [`docs/querying-data.md`](docs/querying-data.md) — practical guide to discovering and querying available data
- [`docs/abstraction-model.md`](docs/abstraction-model.md) — Session/Lap/ChannelMatrix/LapSample model and design invariants
- [`docs/channels-and-units.md`](docs/channels-and-units.md) — canonical channel names, aliases, units, transforms, and availability
- [`docs/testing.md`](docs/testing.md) — fixture strategy and how `pnpm test` validates the abstraction

Format references:

- [`docs/motec_format.md`](docs/motec_format.md) — MoTeC `.ld` binary format notes
- [`docs/pds_format.md`](docs/pds_format.md) — Pi/Cosworth `.pds` format notes
- [`docs/VBO_FORMAT.md`](docs/VBO_FORMAT.md) — VBOX `.vbo` text format notes
- [`docs/video_sync.md`](docs/video_sync.md) — video synchronization strategies
- [`docs/video-matching.md`](docs/video-matching.md) — video file discovery and alignment

## Testing

```bash
pnpm test
```

`pnpm test` runs fast unit tests, synthetic cross-format abstraction tests for MoTeC/PDS/VBO semantics, and a public VBO real-fixture abstraction test. Proprietary MoTeC and PDS fixtures are intentionally not committed.

For the exhaustive large fixture suite:

```bash
pnpm test:fixtures
```
