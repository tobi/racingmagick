# Querying data

This page answers the most common question: **what data do I have, and how do I query it?**

## Parse a file

```ts
import { parseFile, parseVBO, parsePDS, parseMoTeC } from 'racingmagick';

const session = await parseFile('race.ld');

// Or use explicit format helpers:
const vbo = await parseVBO('race.vbo');
const pds = await parsePDS('race.pds');
const motec = await parseMoTeC('race.ld');
```

When parsing from a `Uint8Array`, pass the format explicitly:

```ts
const session = await parseFile(bytes, 'vbo');
```

## Discover available channels

```ts
console.log(session.channelNames());
console.table(session.channelsInfo());
```

`channelsInfo()` returns:

```ts
type ChannelInfo = {
  name: string;
  index: number;
  unit: string | null;
  sampleRate: number;
  sampleCount: number;
  required: boolean;
};
```

Example:

```ts
console.log(session.channelInfo('speed'));
// {
//   name: 'speed',
//   index: 3,
//   unit: 'km/h',
//   sampleRate: 100,
//   sampleCount: 123456,
//   required: true
// }
```

## Availability flags

For common optional data, use `session.has` or `lap.has`:

```ts
if (session.has.gps) {
  console.log('GPS lat/lon are available');
}

if (session.has.brakePressure) {
  console.log('front brake pressure available in bar');
}

if (session.has.wheelSpeeds) {
  console.log('all four wheel speeds are present');
}

if (session.has.tireTemps) {
  console.log('all four tire temperature channels are present');
}
```

Group flags are intentionally strict. For example, `wheelSpeeds` is true only when all four corner wheel speeds exist.

## Read a session channel

```ts
const speed = session.channelOrThrow('speed'); // required, km/h
const rpm = session.channel('rpm');            // optional, Float64Array | null

if (rpm) {
  let max = -Infinity;
  for (const value of rpm) max = Math.max(max, value);
  console.log(max);
}
```

Use:

- `channel(name)` when a channel might not exist
- `channelOrThrow(name)` when missing data is an error

## Read lap data

```ts
const lap = session.fastestLap() ?? session.lap(0);

const speed = lap.channelOrThrow('speed');      // subarray view, zero-copy
const brake = lap.channel('brakePressure');     // bar | null

console.log(lap.lapTime, lap.totalDistance);
console.log(lap.channelInfo('speed'));
```

Lap channels are `Float64Array.subarray()` views into the session matrix. They do not copy telemetry data.

## Query by track position

`lap.at(position)` returns an interpolated `LapSample` at normalized lap position.

```ts
const entry = lap.at(0.30);
const apex = lap.at(0.42);
const exit = lap.at(0.55);

console.log(apex.speed);         // km/h
console.log(apex.throttle);      // ratio, 0..1
console.log(apex.brakePressure); // bar | null
console.log(apex.gpsLat);        // degrees | null
```

Typed getters are available for common channels. For everything else, use the generic API:

```ts
console.log(apex.get('wheelSpeedFL'));
console.log(apex.get('custom_sensor_1'));
console.log(apex.getOr('rpm', 0));
console.log(apex.toObject(['speed', 'throttle', 'rpm', 'brakePressure']));
```

## Query by time or distance

```ts
const afterOneSecond = lap.atTime(1.0);
const atFirstKilometer = lap.atByDistance(1000);

const brakingZone = lap.sliceByDistance(1200, 1450);
for (const sample of brakingZone) {
  console.log(sample.speed, sample.brakePressure);
}
```

## Resample for charts

```ts
const speedTrace = lap.channelAtPositions('speed', 1000);
const throttleTrace = lap.channelAtPositions('throttle', 1000);
```

This is ideal for plotting because every lap can be compared on the same normalized x-axis.

## Compare two laps

```ts
const timed = session.timedLaps();
const a = timed[0];
const b = timed[1];

if (a && b) {
  const delta = a.delta(b);
  console.log(delta.totalDelta, 'ms');
  console.log(delta.deltaAt(0.5), 'ms at halfway');
  console.log(delta.deltaTrace(1000));
}
```

Positive delta means the first lap is slower at that position.

## GPS trace

```ts
if (lap.has.gps) {
  const trace = lap.gpsTrace();        // [lat, lon][]
  const bounds = lap.gpsBounds();      // north/south/east/west
  console.log(trace?.length, bounds);
}
```

## Warnings

A parsed session can contain warnings when the abstraction had to repair or infer data:

```ts
for (const warning of session.warnings) {
  console.warn(warning.code, warning.message);
}
```

Common warning codes:

| Warning | Meaning |
|---|---|
| `distance-channel-missing` | distance was integrated from speed |
| `throttle-fallback` | post-TC throttle was used as primary throttle |
| `coordinate-conversion` | GPS coordinates were converted to decimal degrees |
| `gps-quality-poor` | GPS was not good enough for position source |
| `no-lap-boundaries` | the parser could not identify multiple laps |
