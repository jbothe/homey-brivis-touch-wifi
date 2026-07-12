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
  evaporative systems — the pump). Changing a unit-wide control on one zone propagates to the
  others, just as it does between the physical controllers. Pairing discovers the module on the LAN
  via UDP broadcast and lists the installed zones.

The zone device's on/off is mode-aware, matching the hardware: in evaporative mode it switches that
zone's cooler independently (each zone has its own), while in heating/cooling it switches the whole
system on or off (and the sibling zones reflect it).

All zone devices share a single connection to the module (owned by the app, in `app.ts`), since the
module only accepts one TCP connection at a time.

## Development

```sh
npm install
npm run build            # tsc typecheck
homey app validate --level debug
homey app run             # run against a real Homey on the same LAN as the module
```

## Project layout

- `lib/rinnai/` — vendored protocol core (TCP/UDP discovery, status parsing, command protocol)
  plus `RinnaiConnection.ts`, the typed wrapper the rest of the app talks to.
- `drivers/zone/` — the Homey driver/device implementation.
- `.homeycompose/` — source of truth for `app.json` (generated — do not edit `app.json` directly).

## Status

Early implementation: connects, discovers, and controls heat/cool/evap mode, zone temperature and
on/off, fan and pump. Not yet implemented: Flow cards, schedule/advance/manual switches, and a
manual IP override (the module must be reachable via UDP broadcast discovery for now).
