# racingmagick

Universal motorsport telemetry parsing and querying.

`racingmagick` turns MoTeC, Pi/Cosworth, and VBOX logs into one normalized model:

```text
Session → Lap → ChannelMatrix → LapSample
```

The goal is that analysis code never has to care whether the original file called speed `Corr Speed`, `Vehicle_Speed`, `Ground Speed`, or `Speed`, or whether it was stored as `m/s`, `mph`, or `km/h`.

```ts
import { parseFile } from 'racingmagick';

const session = await parseFile('race.vbo');
const lap = session.fastestLap() ?? session.lap(0);

console.log(session.driver, session.vehicle, session.track);
console.log(lap.displayLabel, lap.lapTime, 'ms');

const speed = lap.channelOrThrow('speed'); // Float64Array, km/h
const apex = lap.at(0.42);

console.log(apex.speed, apex.throttle, apex.brakePressure);
```

## What you get

- normalized canonical channel names
- normalized units
- constant-rate channel matrix
- zero-copy channel access
- lap-aware slicing and interpolation
- typed sample getters plus generic `get()` access
- real fixture coverage for MoTeC, PDS, and VBO

## Supported formats

| Format | Extension | Notes |
|---|---:|---|
| MoTeC i2 | `.ld` + `.ldx` | Binary logger/sim exports |
| Pi/Cosworth | `.pds` | Native and export variants |
| VBOX | `.vbo` | Text logs with GPS/video metadata |

## Next steps

- [Query available data](./querying-data.md)
- [Understand the abstraction model](./abstraction-model.md)
- [Browse canonical channels and units](./channels-and-units.md)
- [Run and extend the fixture tests](./testing.md)
