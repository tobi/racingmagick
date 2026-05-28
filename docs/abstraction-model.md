# Abstraction model

The core model is intentionally small and predictable.

```text
Session
  └─ ChannelMatrix
  └─ Lap[]
       └─ LapSample / LapSampleSlice
```

## Session

A `Session` is the normalized representation of one telemetry file.

Important properties:

```ts
session.id              // stable hash for this file + format + duration
session.fileURL
session.format          // 'motec' | 'pds' | 'vbo'
session.driver
session.driverId
session.vehicle
session.track
session.date
session.sampleRate
session.totalDuration
session.totalDistance
session.lapCount
session.laps
session.has             // availability flags
session.warnings
session.video
session.matrix
```

Important methods:

```ts
session.channelNames()
session.channelsInfo()
session.channelInfo(name)
session.hasChannel(name)
session.channel(name)
session.channelOrThrow(name)
session.lap(index)
session.lapByNumber(number)
session.timedLaps()
session.fastestLap()
session.stints()
session.saveVbo(directory, filename)
```

## ChannelMatrix

`ChannelMatrix` stores all channels as rows in `Float64Array[]`.

```text
channels[channelIndex][sampleIndex] = normalized value
```

All channels are resampled to a constant sample rate. Continuous channels use linear interpolation. Discrete channels, such as gear, use nearest-neighbor interpolation.

The first five rows are reserved:

| Index | Channel | Unit |
|---:|---|---:|
| 0 | `time` | `s` |
| 1 | `distance` | `m` |
| 2 | `trackPosition` | `ratio` |
| 3 | `speed` | `km/h` |
| 4 | `throttle` | `ratio` |

These rows are always allocated. `speed` and `throttle` must be present in source data or recoverable via fallback logic. `distance` can be integrated from speed if missing.

## Lap

A `Lap` is a range into the session matrix:

```ts
lap.startIdx
lap.endIdx
```

It does not own channel arrays. `lap.channel(name)` returns a `Float64Array.subarray()` view into the session row.

Lap metadata:

```ts
lap.lapIndex
lap.lapNumber
lap.displayLabel
lap.kind             // out-lap, in-lap, flying, first-flying, slow
lap.lapTime          // milliseconds
lap.startTime
lap.endTime
lap.sampleRate
lap.sampleCount
lap.totalDistance
lap.sectors
lap.positionSource   // gps | distance | speed-integrated
lap.has
```

Lap query methods:

```ts
lap.samples
lap.channel(name)
lap.channelOrThrow(name)
lap.at(trackPosition)
lap.atTime(seconds)
lap.atByDistance(meters)
lap.slice(fromPosition, toPosition)
lap.sliceByDistance(fromMeters, toMeters)
lap.channelAtPositions(name, resolution)
lap.resample(count)
lap.gpsTrace()
lap.gpsBounds()
lap.delta(otherLap)
```

## LapSample

A `LapSample` is a zero-allocation view into one sample, or an interpolated view between two samples.

Required typed getters:

```ts
sample.time
sample.distance
sample.trackPosition
sample.speed
sample.throttle
```

Optional typed getters return `number | null`:

```ts
sample.rpm
sample.gear
sample.brakePressure
sample.steering
sample.gpsLat
sample.gpsLon
sample.wheelSpeedFL
sample.tireTempFL
```

Generic access works for any canonical or custom channel:

```ts
sample.get('speed')
sample.get('brakePressure')
sample.getOr('rpm', 0)
sample.has('gpsLat')
sample.toObject(['speed', 'throttle', 'rpm'])
```

## Design invariants

The fixture abstraction tests assert these invariants across MoTeC, PDS, and VBO:

1. required canonical channels exist for every parsed session
2. canonical channels use the same units regardless of source format
3. session/lap/channel APIs expose zero-copy views where possible
4. optional channels are explicit: missing means `null`, not `0`
5. time and distance are finite and monotonic
6. speed, throttle, GPS, and track position have physically plausible ranges
7. `LapSample.get(name)` agrees with typed getters

## Why a matrix?

A matrix gives predictable performance:

- one typed array per channel
- fast numeric loops
- zero-copy lap slices
- compact memory representation
- direct transfer to plotting or numerical code

The tradeoff is that channels are resampled to one rate. For motorsport analysis this makes lap comparison, plotting, and interpolation much simpler.
