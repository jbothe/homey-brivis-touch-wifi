# Brivis Touch

A [Homey](https://homey.app) app for controlling a Brivis ducted gas heating / evaporative cooling
system via its Wi-Fi module — the **Brivis Touch Wi-Fi** module, formerly marketed as the
**Rinnai Touch** Wi-Fi module (same hardware, same protocol).

There's no public SDK for this module. The device/network protocol layer in this app is adapted
from [homebridge-rinnai-touch-plugin](https://github.com/mantorok1/homebridge-rinnai-touch-plugin)
(MIT licensed) — see [`lib/rinnai/NOTICE.md`](lib/rinnai/NOTICE.md) for attribution details.

## Devices

- **Brivis Touch Zone** — one device per zone controller (e.g. Upstairs, Downstairs), modelled on
  the physical wall controllers, which are peers: each exposes the zone's target/measured
  temperature plus the unit-wide controls (operating mode, circulation fan, fan speed, and — on
  evaporative systems, while the system is actually in evap mode — the pump). Changing a unit-wide
  control on one zone propagates to the others, just as it does between the physical controllers.
  Pairing discovers the module on the LAN via UDP broadcast and lists the installed zones.

Each zone also exposes a read-only **"Actively heating/cooling"** status, separate from the on/off
switch — whether the zone is actually calling for heat/cool right now, as opposed to whether the
system is switched on.

The zone device's on/off is mode-aware, matching the hardware: in evaporative mode it switches that
zone's cooler independently (each zone has its own), while in heating/cooling it switches the whole
system on or off (and the sibling zones reflect it, including the toggle's label, which reads
"Zone Power" or "System Power" accordingly).

All zone devices share a single connection to the module (owned by the app, in `app.ts`), since the
module only accepts one TCP connection at a time.

## Keeping in sync

The module only streams status while a connection is open, and the connection is closed again after
a few seconds of idle to leave room for other clients (e.g. the official phone app). To pick up
changes made outside Homey — at a wall controller, or the phone app — `app.ts` polls every 15s to
refresh state, logging a one-line snapshot of the full state (mode, on/off, fan, pump, and every
per-zone field) on each successful poll.

After three consecutive failed polls (~45s) the zone devices are marked unavailable rather than
continuing to serve their last known values, and become available again on the next successful poll.
A command the module never acknowledges (three attempts) fails the capability, so Homey reverts the
value instead of showing a setpoint the unit never took.

## Flow cards

- **Operating mode** — trigger (changed to), condition (is/is not), action (set to), for
  heat/cool/evap.
- **Actively heating/cooling** — trigger (changed), condition (is/is not). Read-only, so no action.
- **Fan speed** — action (set to 1–16).

On/off, target temperature and measured temperature are standard Homey capabilities, so their
triggers/conditions/actions (turn on/off, toggle, temperature changed, set temperature, etc.) are
provided automatically by Homey — no app code needed for those.

## Development

```sh
npm install
npm run build             # tsc typecheck
npm run lint
npm test                  # runs test/*.test.ts via node's built-in test runner
homey app validate --level debug
homey app run              # run against a real Homey on the same LAN as the module
```

CI (`.github/workflows/`) runs lint, test and `homey app validate --level verified` on every push,
plus manual workflows to bump the app version and publish.

## Project layout

- `lib/rinnai/` — vendored protocol core (TCP/UDP discovery, status parsing, command protocol)
  plus `RinnaiConnection.ts`, the typed wrapper the rest of the app talks to.
- `drivers/zone/` — the Homey driver/device implementation.
- `test/` — unit tests for the vendored protocol core's path-resolution logic (the highest-risk
  reverse-engineered piece).
- `.homeycompose/` — source of truth for `app.json` (generated — do not edit `app.json` directly).

## Status

Connects, discovers, and controls heat/cool/evap mode, per-zone temperature and on/off, fan, pump,
and polls for out-of-band changes. Has a starter set of Flow cards (above). Not yet implemented:
schedule/advance/manual controls (read for diagnostics, not exposed as capabilities or actions), and
a manual IP override (the module must be reachable via UDP broadcast discovery for now). The zone
driver's icons are still placeholders, not real artwork.
