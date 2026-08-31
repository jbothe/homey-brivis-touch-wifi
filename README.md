# Brivis

A [Homey](https://homey.app) app for Brivis ducted gas heating and evaporative cooling, controlled
over the LAN via the
[Brivis Touch Wi-Fi](https://www.brivis.com.au/online/heating/gas-ducted-heating/brivis-touch-wi-fi/)
controller module. The same hardware was previously sold as the **Rinnai Touch** Wi-Fi module and
speaks the same protocol.

The app is named for the vendor and its single driver for the device, per the App Store
[guidelines](https://apps.developer.homey.app/app-store/guidelines) on naming.

There is no public SDK. The protocol layer is adapted from
[homebridge-rinnai-touch-plugin](https://github.com/mantorok1/homebridge-rinnai-touch-plugin)
(MIT). See [`lib/rinnai/NOTICE.md`](lib/rinnai/NOTICE.md) for attribution and the list of local
changes.

## Devices

**Touch Wi-Fi Zone**, one device per zone controller, modelled on the physical wall controllers,
which are peers. Each exposes its own target and measured temperature plus the unit-wide controls
(operating mode, circulation fan, fan speed, and the pump on evaporative systems). Changing a
unit-wide control on one zone propagates to the others, exactly as it does between the wall
controllers. Pairing discovers the module by UDP broadcast and lists the installed zones.

Four read-only statuses report what the system and wall controller are doing. Homey reflects them
but never writes them, even where the protocol would allow it:

| Status | Meaning |
| --- | --- |
| Actively heating/cooling | Whether the zone is calling for heat/cool now, as opposed to being switched on |
| Control mode | Following the schedule, or a manual setpoint |
| Schedule override | None, Advance or Operation, so an Advance pressed at a wall controller is visible |
| Schedule period | Wake, Leave, Return, Pre-sleep or Sleep. Heat/cool only; unknown in evap mode |

"Actively heating/cooling" prefers the per-zone field on multi-setpoint hardware and falls back to
the unit-wide flag otherwise, because the per-zone path does not exist on single-setpoint systems.

### On/off is mode-aware

In evaporative mode on a multi-setpoint system each zone has its own cooler, so the toggle switches
that zone alone. Everywhere else it switches the whole system, and the sibling zones follow. The
label tracks this, reading "Zone Power" or "System Power" accordingly.

In heating/cooling, on/off and the circulation fan are two views of one tri-state field in the unit,
so they behave as a pair:

| On/off | Fan | Unit |
| --- | --- | --- |
| on | off | heating/cooling |
| on | on | fan only |
| off | any | off |

Turning the fan **on** therefore switches the unit from heating to fan-only, and turning it **off**
returns it to heating rather than shutting it down. Evaporative mode has genuinely independent
controls and behaves as expected.

## Keeping in sync

The module accepts one TCP client at a time and only streams status while connected, so all zone
devices share a single connection owned by `app.ts`. It closes 1.5s after the request queue drains,
which leaves the module free roughly 80% of the time. Holding it longer is what makes the official
phone app report the unit as busy.

`app.ts` polls every 15s to catch changes made at a wall controller or in the phone app, logging a
one-line snapshot of the full state on each poll.

Two failure modes are handled deliberately:

- While the system is off, the module stops reporting the per-zone operation blocks
  (`{mode}.Z{zone}O`) that hold the target temperature, control mode and schedule override.
  Setpoints still apply, but cannot be echoed back until the system is on, so those commands are
  sent once and logged as unconfirmed instead of being retried or failed.
- After three consecutive failed polls (~45s) the devices are marked unavailable rather than serving
  stale values, recovering on the next successful poll. A command the module never acknowledges
  (three attempts) fails the capability, so Homey reverts rather than showing a setpoint the unit
  never took.

## Flow cards

| Card | Trigger | Condition | Action |
| --- | --- | --- | --- |
| Operating mode | changed to | is / is not | set to |
| Actively heating/cooling | changed | is / is not | n/a, read-only |
| Fan speed | | | set to 1 to 16 |

On/off and the temperatures are standard Homey capabilities, so Homey provides their cards
automatically. The three schedule and control-mode statuses have no cards yet.

## Development

```sh
npm install
npm run build              # tsc typecheck
npm run lint
npm test                   # test/*.test.ts via node's built-in runner
homey app validate --level verified
homey app run              # against a real Homey on the module's LAN
```

CI runs lint, tests and `homey app validate --level verified` on every push, plus manual workflows
to bump the version and publish. The validate and publish workflows install dependencies first:
`tsconfig.json` extends a package, so without `node_modules` the Athom actions fail with an
unhelpful "Tsconfig validation failed".

## Project layout

- `lib/rinnai/` vendored protocol core (UDP discovery, TCP framing, status parsing, commands) plus
  `RinnaiConnection.ts`, the typed wrapper everything else uses.
- `drivers/zone/` the driver and device. `driver.ts` derives a paired device's capabilities from
  the manifest, minus `onoff.pump`, which the device adds and removes from the live mode.
- `test/` unit tests for the protocol core: path resolution, status parsing, command encoding, TCP
  framing, failure paths, and a round trip against a fake module.
- `.homeycompose/` source of truth for `app.json`. Never edit `app.json` directly; it is generated.

## App Store assets

- `assets/icon.svg` the Brivis wordmark, white on a 960x960 canvas. White because Homey paints
  `brandColor` (`#132A4D`, the Brivis navy) behind the icon, where the vendor's navy would vanish.
- `drivers/zone/assets/icon.svg` the fingerprint mark from the official Touch phone app. Owners
  recognise it, and a driver may not reuse the app's icon.
- `assets/rt_*.svg` one icon per custom capability, line art on the same canvas, stroked in
  `currentColor` so it follows the surrounding UI.
- `assets/images/` (250x175, 500x350) and `drivers/zone/assets/images/` (75/500/1000 square) are
  Brivis' own marketing artwork for this product, which is what the guidelines ask for. The optional
  1000x700 app XLarge is not supplied, so the manifest declares only `small` and `large`.
- `README.txt` plus `README.nl.txt`, `README.fr.txt` and `README.de.txt` are the App Store listing
  text. `homey app publish` refuses to run without `README.txt`. Plain text only: no Markdown, no
  URLs, one or two paragraphs. This file is the developer readme and is not shown in the store.

## Translations

English, Dutch, French and German across the description, driver, capabilities (titles, enum values,
Insights titles) and every Flow card. A partially translated app is treated as worse than an English
one, so a string is translated everywhere or nowhere. The app name is exempt, being the brand.

`ONOFF_TITLES` in `drivers/zone/device.ts` is the one translated string outside a manifest, because
the on/off label depends on the current mode. Keep it in step when adding a language.

## Status

Connects, discovers and controls mode, per-zone temperature and on/off, fan and pump, and polls for
out-of-band changes. Not implemented: writing the schedule, advance and manual controls (exposed
read-only, nothing sets them), per-zone dampers in heat/cool, and a manual IP override, so the
module must be reachable by UDP broadcast.

The schedule period codes (`W`, `L`, `R`, `P`, `S`) are inferred from the protocol path table rather
than observed. An unrecognised value is logged and left unset rather than guessed.
