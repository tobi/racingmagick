# Examples

## Print a session summary

```ts
import { parseFile } from 'racingmagick';

const session = await parseFile(process.argv[2]!);

console.log(`${session.driver} — ${session.vehicle}`);
console.log(`${session.track} (${session.format})`);
console.log(`${session.lapCount} laps, ${session.sampleRate} Hz`);
console.table(session.channelsInfo());
```

## Find fastest speed on fastest lap

```ts
const lap = session.fastestLap();
if (!lap) throw new Error('No timed laps');

const speed = lap.channelOrThrow('speed');
let max = -Infinity;
for (const value of speed) max = Math.max(max, value);

console.log(max, 'km/h');
```

## Export a plotting trace

```ts
const lap = session.fastestLap() ?? session.lap(0);
const resolution = 500;

const rows = Array.from({ length: resolution }, (_, i) => {
  const position = i / (resolution - 1);
  const sample = lap.at(position);
  return {
    position,
    speed: sample.speed,
    throttle: sample.throttle,
    brakePressure: sample.brakePressure,
  };
});

console.log(JSON.stringify(rows));
```

## Compare two laps

```ts
const [a, b] = session.timedLaps();
if (a && b) {
  const delta = a.delta(b);
  console.log('total', delta.totalDelta, 'ms');
  console.log('halfway', delta.deltaAt(0.5), 'ms');
}
```

## Inspector example app

A lightweight local inspector lives in:

```text
examples/inspector
```

Run it with:

```bash
cd examples/inspector
pnpm install
pnpm dev
```

Then open `http://localhost:3456`.
