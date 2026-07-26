'use strict';

import Homey from 'homey';
import type { RinnaiTouchApp } from '../../app';
import type { RinnaiMode, RinnaiZone } from '../../lib/rinnai/RinnaiConnection';

// Unit-wide controls that live on every zone device (they mirror each other via
// the app's event fan-out). onoff.pump is deliberately not included here - it's
// evap-only and added/removed dynamically by the device based on live mode,
// not fixed at pairing time (see ZoneDevice#syncPumpCapability).
const BASE_CAPABILITIES = [
  'target_temperature',
  'measure_temperature',
  'rt_zone_active',
  'onoff',
  'rt_operating_mode',
  'onoff.fan',
  'rt_fan_speed',
];

// Flow card arg/state property names must match their capability id exactly
// (that's the convention Homey's own auto-generated flow cards use, e.g.
// thermostat_mode), and capability ids are snake_case here.
/* eslint-disable camelcase */
interface OperatingModeArgs { rt_operating_mode: RinnaiMode }
interface FanSpeedArgs { rt_fan_speed: number }
/* eslint-enable camelcase */

class ZoneDriver extends Homey.Driver {

  private get app(): RinnaiTouchApp {
    return this.homey.app as unknown as RinnaiTouchApp;
  }

  async onInit() {
    // Triggers (rt_operating_mode_changed, rt_zone_active_changed) are fired
    // explicitly from device.ts when it detects a real change - no listener
    // needed here unless the card has a filter arg, which only the mode
    // trigger does.
    this.homey.flow.getDeviceTriggerCard('rt_operating_mode_changed')
      .registerRunListener(async (args: OperatingModeArgs, state: OperatingModeArgs) => (
        args.rt_operating_mode === state.rt_operating_mode
      ));

    this.homey.flow.getConditionCard('rt_operating_mode_is')
      .registerRunListener(async (args: OperatingModeArgs & { device: Homey.Device }) => (
        args.device.getCapabilityValue('rt_operating_mode') === args.rt_operating_mode
      ));

    this.homey.flow.getActionCard('rt_operating_mode_set')
      .registerRunListener(async (args: OperatingModeArgs) => {
        await this.app.rinnai.setMode(args.rt_operating_mode);
      });

    this.homey.flow.getConditionCard('rt_zone_active_is')
      .registerRunListener(async (args: { device: Homey.Device }) => (
        args.device.getCapabilityValue('rt_zone_active') === true
      ));

    this.homey.flow.getActionCard('rt_fan_speed_set')
      .registerRunListener(async (args: FanSpeedArgs) => {
        await this.app.rinnai.setFanSpeed(args.rt_fan_speed);
      });
  }

  async onPairListDevices() {
    await this.app.rinnai.init();

    const { rinnai } = this.app;

    const alreadyPaired = new Set(
      this.getDevices().map((device) => device.getData().zone),
    );

    return (rinnai.controllers as RinnaiZone[])
      .filter((zone) => !alreadyPaired.has(zone))
      .map((zone) => ({
        name: rinnai.getZoneName(zone),
        data: { zone },
        capabilities: BASE_CAPABILITIES,
      }));
  }

}

module.exports = ZoneDriver;
