# Formats

`racingmagick` supports three telemetry families through the same public model.

## MoTeC i2

Extensions:

```text
.ld
.ldx
```

The `.ld` file contains the binary log data. `.ldx` sidecars may contain indexing/metadata depending on the export source.

Use:

```ts
const session = await parseMoTeC('race.ld');
```

See [MoTeC format notes](./motec_format.md).

## Pi/Cosworth PDS

Extension:

```text
.pds
```

PDS files can be native recordings or exported variants. Channel naming tends to be ECU/logger-specific, so alias priority and unit normalization are especially important.

Use:

```ts
const session = await parsePDS('race.pds');
```

See [PDS format notes](./pds_format.md).

## VBOX

Extension:

```text
.vbo
```

VBO is text-based and GPS-native. VBO files often include sections for video synchronization and lap timing metadata.

Use:

```ts
const session = await parseVBO('race.vbo');
```

See [VBO format notes](./VBO_FORMAT.md).

## Format-independent code

Prefer `parseFile()` when file extension is known:

```ts
const session = await parseFile(path);
```

After parsing, downstream code should use canonical channels and avoid branching on `session.format` unless it truly needs format-specific metadata.

```ts
const lap = session.fastestLap() ?? session.lap(0);
const speed = lap.channelOrThrow('speed');
const throttle = lap.channelOrThrow('throttle');
```
