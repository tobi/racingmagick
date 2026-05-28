# Channels and units

`racingmagick` resolves raw logger channels into canonical channel names and normalized engineering units.

## Resolution pipeline

For each raw channel:

1. normalize the raw name: lowercase, strip punctuation, handle spaces/underscores
2. match against ordered alias lists
3. pick the highest-priority alias for each canonical channel
4. apply the channel's unit transform
5. store the result in the `ChannelMatrix`

Example:

```ts
resolveChannelName('Brake_Pressure_Front') // 'brakePressure'
resolveChannelName('Corr Speed')           // 'speed'
resolveChannelName('FBWDriverTPS')         // 'throttle'
```

## Public channel catalog API

```ts
import {
  canonicalChannelNames,
  getCanonicalUnit,
  getChannelDefinition,
  resolveChannelName,
} from 'racingmagick';

console.log(canonicalChannelNames());
console.log(getCanonicalUnit('speed'));              // km/h
console.log(getChannelDefinition('speed')?.aliases); // alias priority list
console.log(resolveChannelName('Vehicle_Speed'));    // speed
```

## Core channels

| Canonical | Unit | Required | Notes |
|---|---:|---:|---|
| `time` | `s` | yes | generated if missing |
| `distance` | `m` | yes | integrated from speed if missing |
| `trackPosition` | `ratio` | yes | 0..1, GPS or distance derived |
| `speed` | `km/h` | yes | vehicle/reference speed |
| `throttle` | `ratio` | yes | driver demand, fallback from actual throttle if needed |

## Common optional channels

| Canonical | Unit | Meaning |
|---|---:|---|
| `rpm` | `rpm` | engine speed |
| `gear` | `gear` | selected gear |
| `throttleActual` | `ratio` | post-TC/actual throttle |
| `brakePedal` | `ratio` | brake pedal position |
| `brakePressure` | `bar` | front brake pressure |
| `brakePressureRear` | `bar` | rear brake pressure |
| `clutchPedal` | `ratio` | clutch pedal |
| `steering` | `deg` | steering angle |
| `gLong` | `g` | longitudinal acceleration |
| `gLat` | `g` | lateral acceleration |
| `heading` | `deg` | GPS/vehicle heading |
| `yawRate` | `deg/s` | yaw rate |

## GPS channels

| Canonical | Unit |
|---|---:|
| `gpsLat` | `deg` |
| `gpsLon` | `deg` |
| `gpsAlt` | `m` |
| `gpsSpeed` | `km/h` |
| `gpsSatellites` | `count` |
| `gpsFix` | `fix` |

Coordinates are converted to decimal degrees when the parser detects a supported non-decimal coordinate system.

## Wheel, damper, and tire channels

| Canonical group | Unit |
|---|---:|
| `wheelSpeedFL/FR/RL/RR` | `km/h` |
| `damperFL/FR/RL/RR` | `mm` |
| `tirePressureFL/FR/RL/RR` | `bar` |
| `tireTempFL/FR/RL/RR` | `°C` |
| `tireSlipAngleFL/FR/RL/RR` | `deg` |
| `tireSlipRatioFL/FR/RL/RR` | `ratio` |
| `tireWearFL/FR/RL/RR` | `ratio` |
| `tireLoadFL/FR/RL/RR` | `N` |

## Unit normalization examples

| Quantity | Accepted source units | Normalized unit |
|---|---|---:|
| speed | `km/h`, `m/s`, `mph`, `knots` | `km/h` |
| ratio | `%`, `percent`, `ratio`, empty percentage-like values | `ratio` |
| pressure | `bar`, `psi`, `kPa`, `MPa`, `mbar`, `Pa` | `bar` |
| acceleration | `g`, `m/s2`, `m/s²` | `g` |
| angle | `deg`, `rad` | `deg` |
| yaw rate | `deg/s`, `rad/s` | `deg/s` |
| distance | `m`, `km`, `mi`, `ft` | `m` |
| temperature | `C`, `F`, `K` | `°C` |
| damper travel | `mm`, `cm`, `m`, `in` | `mm` |
| load | `N`, `kN`, `lbf`, `kgf` | `N` |

## Throttle semantics

Different systems record different throttle meanings:

- driver pedal demand
- throttle plate position
- post-traction-control actual throttle

The canonical policy is:

1. if a driver throttle channel exists, it becomes `throttle`
2. if actual/post-TC throttle also exists, it becomes `throttleActual`
3. if only actual/post-TC throttle exists, it is used as `throttle` and a `throttle-fallback` warning is emitted

This keeps the required API usable while preserving information when both signals exist.

## Custom channels

Unrecognized channels are preserved with sanitized names:

```ts
const custom = session.channel('custom_sensor_42');
```

If a custom raw name collides with a canonical channel, it is prefixed internally to avoid ambiguous access.
