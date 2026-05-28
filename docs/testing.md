# Testing

This project treats the normalized abstraction as the product. Tests are designed to prove that MoTeC, Pi/Cosworth, and VBOX files all expose the same query API and units.

## Run tests

```bash
pnpm install
pnpm test
```

`pnpm test` runs:

- pure unit tests for channel resolution, unit transforms, matrix resampling, GPS, lap classification, and edge cases
- synthetic cross-format abstraction tests
- a public VBO real-fixture abstraction test

## Fixture strategy

The public repo includes only shareable telemetry fixtures. Proprietary MoTeC
and PDS files are intentionally not committed.

```text
fixtures/vbo/25IT04_RdAm_PT2_Run01_RD.vbo
```

Synthetic tests cover cross-format MoTeC/PDS/VBO normalization semantics without
requiring proprietary files. Fixture-dependent tests skip automatically when the
corresponding file is not present.

The exhaustive fixture suite can be run locally when all large private fixtures
are available:

```bash
pnpm test:fixtures
```

## What fixture abstraction tests assert

For every selected real file, `src/__tests__/fixture-abstraction.test.ts` checks:

- session parses successfully
- `format`, `id`, `sampleRate`, `totalDuration`, `totalDistance`, and `lapCount` are coherent
- required canonical channels exist:
  - `time`
  - `distance`
  - `trackPosition`
  - `speed`
  - `throttle`
- normalized units are correct:
  - speed in `km/h`
  - distance in `m`
  - throttle in `ratio`
  - GPS in decimal degrees
  - pressure in `bar`
- required channels contain finite values
- time and distance are monotonic
- speed, throttle, track position, and GPS ranges are plausible
- `Session.channel()` is the same data as `ChannelMatrix.row()`
- `Lap.channel()` is a zero-copy subarray view
- `LapSample.get(name)` matches typed getters
- missing optional data returns `null`

## Synthetic abstraction tests

`src/__tests__/abstraction.test.ts` builds synthetic MoTeC-like, PDS-like, and VBO-like sessions with equivalent physical data but different raw names and units.

For example, the same speed trace may be represented as:

- MoTeC: `Corr Speed`, `m/s`
- PDS: `Speed`, `km/h`
- VBO: `Vehicle_Speed`, `mph`

The test asserts all three produce the same canonical `speed` channel in `km/h`.

## Adding a new channel

When adding a canonical channel:

1. add aliases to `CHANNEL_PRIORITIES` in `src/channels.ts`
2. add or reuse a unit transform
3. add the canonical unit to `NORMALIZED_CHANNEL_UNITS`
4. expose a typed getter on `LapSample` if it is common enough
5. update `ChannelAvailability` if it belongs in a grouped flag
6. add synthetic tests for name resolution and unit normalization
7. add fixture assertions if real files contain the channel

## Adding a new fixture

Prefer small representative files. If a large file is necessary, keep only one or two per format/category.

Checklist:

- put file under `fixtures/<format>/`
- update `.gitignore` allow-list only if it is public/shareable and should be committed
- add it to `FIXTURE_CASES` in `src/__tests__/fixture-abstraction.test.ts`
- assert only format-appropriate requirements
- run `pnpm test`

## CI expectation

The default CI command should be:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm docs:build
```
