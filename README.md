# Brivis

A [Homey](https://homey.app) app for controlling a Brivis ducted gas heating / evaporative cooling
system via the [**Brivis Touch Wi-Fi**](https://www.brivis.com.au/online/heating/gas-ducted-heating/brivis-touch-wi-fi/)
controller module — sold as the *Brivis Touch Wi-Fi Controller Module Kit*, and previously marketed
as the **Rinnai Touch** Wi-Fi module (same hardware, same protocol).

The app is named for the vendor (**Brivis**) and its single driver for the device
(**Touch Wi-Fi Zone**), per the Homey App Store
[guidelines](https://apps.developer.homey.app/app-store/guidelines) on app naming.

There's no public SDK for this module. The device/network protocol layer in this app is adapted
from [homebridge-rinnai-touch-plugin](https://github.com/mantorok1/homebridge-rinnai-touch-plugin)
(MIT licensed) — see [`lib/rinnai/NOTICE.md`](lib/rinnai/NOTICE.md) for attribution details.

## Devices

- **Touch Wi-Fi Zone** — one device per zone controller (e.g. Upstairs, Downstairs), modelled on
  the physical wall controllers, which are peers: each exposes the zone's target/measured
  temperature plus the unit-wide controls (operating mode, circulation fan, fan speed, and — on
  evaporative systems, while the system is actually in evap mode — the pump). Changing a unit-wide
  control on one zone propagates to the others, just as it does between the physical controllers.
  Pairing discovers the module on the LAN via UDP broadcast and lists the installed zones.

Each zone also exposes a read-only **"Actively heating/cooling"** status, separate from the on/off
switch — whether the zone is actually calling for heat/cool right now, as opposed to whether the
system is switched on.

The zone device's on/off is mode-aware, matching the hardware: in evaporative mode on a
multi-setpoint system it switches that zone's cooler independently (each zone has its own), while
everywhere else it switches the whole system on or off (and the sibling zones reflect it, including
the toggle's label, which reads "Zone Power" or "System Power" accordingly).

In heating/cooling, on/off and the circulation fan are two views of a single tri-state control in
the unit — it is either heating/cooling, running the fan alone, or off — so they read as a pair:

| On/off | Fan | Unit |
| --- | --- | --- |
| on | off | heating/cooling |
| on | on | fan only |
| off | — | off |

Turning the fan **on** therefore switches the unit from heating to fan-only, and turning it **off**
returns it to heating rather than shutting it down. (Evaporative mode has genuinely independent
controls and behaves as you would expect.)

All zone devices share a single connection to the module (owned by the app, in `app.ts`), since the
module only accepts one TCP connection at a time.

## Keeping in sync

The module only streams status while a connection is open, and it accepts one client at a time, so
the app closes the connection 1.5s after the request queue drains to leave room for other clients
(e.g. the official phone app). That keeps it off the module ~80% of the time; holding it longer is
what makes the phone app report the unit as busy. To pick up
changes made outside Homey — at a wall controller, or the phone app — `app.ts` polls every 15s to
refresh state, logging a one-line snapshot of the full state (mode, on/off, fan, pump, and every
per-zone field) on each successful poll.

While the system is switched off the module stops reporting the per-zone *operation* blocks
(`{mode}.Z{zone}O`), which is where the target temperature, control mode and schedule override live.
Setpoints still apply — writing one with the system off and then switching it on brings the new
value back — but the module cannot echo them until it is on again, so the app sends those commands
once and logs them as unconfirmed rather than retrying or reporting a failure.

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
- `test/` — unit tests for the reverse-engineered protocol core: path resolution, status parsing and
  command encoding, TCP framing and connection failure paths, and the command round-trip against a
  fake module that speaks the protocol.
- `.homeycompose/` — source of truth for `app.json` (generated — do not edit `app.json` directly).

## Status

Connects, discovers, and controls heat/cool/evap mode, per-zone temperature and on/off, fan, pump,
and polls for out-of-band changes. Has a starter set of Flow cards (above). Not yet implemented:
schedule/advance/manual controls (read for diagnostics, not exposed as capabilities or actions), and
a manual IP override (the module must be reachable via UDP broadcast discovery for now).

## App Store assets

- `assets/icon.svg` — the Brivis wordmark, white on a 960x960 canvas. It is drawn white because
  Homey paints `brandColor` (`#132A4D`, the Brivis navy) *behind* the icon; the vendor's own navy
  would be invisible against it.
- `drivers/zone/assets/icon.svg` — the fingerprint mark the official Brivis/Rinnai Touch phone
  app uses as its own icon; it is the artwork owners of the system already recognise, and it
  plays on the "Touch" name. Deliberately distinct from the app icon above, which the Homey
  guidelines require (a driver must not re-use the app's icon).
- `drivers/zone/assets/images/` — product shot of the module, on white, at 75/500/1000 px square.
- `assets/images/` — app image at 250x175 and 500x350 (10:7). The optional 1000x700 XLarge is
  not supplied, so the manifest declares only `small` and `large`; add both together if a
  higher-resolution original turns up.
- `README.txt` — the App Store listing text (`homey app publish` requires this file, and refuses
  to run without it). Plain text only: no Markdown, no URLs, one to two paragraphs. It is a
  separate file from this one, which is the developer readme and is not shown in the store.
