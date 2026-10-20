'use strict';

import Homey from 'homey';
import type { RinnaiTouchApp } from '../../app';
import type { RinnaiEvapControl, RinnaiZone } from '../../lib/rinnai/RinnaiConnection';

// Evap-only, so added and removed by the device from the live mode (see
// ZoneDevice#syncFromService) rather than fixed at pairing.
const EVAP_ONLY_CAPABILITIES = new Set(['onoff.pump', 'rt_evap_control', 'rt_comfort_level', 'rt_prewet']);

// Flow card arg/state property names must match their capability id exactly
// (that's the convention Homey's own auto-generated flow cards use, e.g.
// thermostat_mode), and capability ids are snake_case here.
/* eslint-disable camelcase */
interface FanSpeedArgs { rt_fan_speed: number }
interface EvapControlArgs { rt_evap_control: RinnaiEvapControl }
interface ComfortLevelArgs { rt_comfort_level: number }
/* eslint-enable camelcase */

class ZoneDriver extends Homey.Driver {

  private get app(): RinnaiTouchApp {
    return this.homey.app as unknown as RinnaiTouchApp;
  }

  async onInit() {
    // The rt_zone_active_changed trigger is fired explicitly from device.ts
    // when it detects a real change, and has no filter arg, so it needs no
    // listener here. Mode cards are Homey's own, from thermostat_mode.
    this.homey.flow.getConditionCard('rt_zone_active_is')
      .registerRunListener(async (args: { device: Homey.Device }) => (
        args.device.getCapabilityValue('rt_zone_active') === true
      ));

    this.homey.flow.getActionCard('rt_fan_speed_set')
      .registerRunListener(async (args: FanSpeedArgs) => {
        await this.command(`set fan speed to ${args.rt_fan_speed}`,
          () => this.app.rinnai.setFanSpeed(args.rt_fan_speed));
      });

    this.homey.flow.getActionCard('rt_evap_control_set')
      .registerRunListener(async (args: EvapControlArgs) => {
        await this.command(`set cooler control to ${args.rt_evap_control}`,
          () => this.app.rinnai.setEvapControl(args.rt_evap_control));
      });

    // Read from the service rather than the device's capability, which does
    // not exist outside evap - there the answer is simply "no".
    this.homey.flow.getConditionCard('rt_evap_control_is')
      .registerRunListener(async (args: EvapControlArgs) => (
        this.app.rinnai.getEvapControl() === args.rt_evap_control
      ));

    this.homey.flow.getActionCard('rt_comfort_level_set')
      .registerRunListener(async (args: ComfortLevelArgs) => {
        await this.command(`set comfort level to ${args.rt_comfort_level}`,
          () => this.app.rinnai.setComfortLevel(args.rt_comfort_level));
      });
  }

  /**
   * As ZoneDevice#command: the outermost handler on the command path, where a
   * failure gets its single log line. Rethrown so the Flow itself is reported
   * as failed rather than quietly continuing.
   */
  private async command(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.error(`Flow failed to ${what}`, error);
      throw error;
    }
  }

  /**
   * What a newly paired zone starts with: everything the driver declares except
   * the evap-only capabilities, which the device adds and removes from the live
   * mode (ZoneDevice#syncOptionalCapability). target_temperature and
   * rt_control_mode are paired regardless and removed the same way in evap.
   *
   * Read from the manifest rather than kept as a second list here. The
   * capabilities returned by onPairListDevices() override the manifest, so a
   * hand-maintained copy drifts silently: three capabilities added to
   * driver.compose.json and not here paired devices without them, which then
   * threw `Invalid Capability` on every sync.
   */
  private pairingCapabilities(): string[] {
    return (this.manifest.capabilities as string[])
      .filter((capability) => !EVAP_ONLY_CAPABILITIES.has(capability));
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
        capabilities: this.pairingCapabilities(),
      }));
  }

}

module.exports = ZoneDriver;
