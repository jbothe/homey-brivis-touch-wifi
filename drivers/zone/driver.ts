'use strict';

import Homey from 'homey';
import type { RinnaiTouchApp } from '../../app';
import type { RinnaiMode, RinnaiZone } from '../../lib/rinnai/RinnaiConnection';

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
        await this.command(`set mode to ${args.rt_operating_mode}`,
          () => this.app.rinnai.setMode(args.rt_operating_mode));
      });

    this.homey.flow.getConditionCard('rt_zone_active_is')
      .registerRunListener(async (args: { device: Homey.Device }) => (
        args.device.getCapabilityValue('rt_zone_active') === true
      ));

    this.homey.flow.getActionCard('rt_fan_speed_set')
      .registerRunListener(async (args: FanSpeedArgs) => {
        await this.command(`set fan speed to ${args.rt_fan_speed}`,
          () => this.app.rinnai.setFanSpeed(args.rt_fan_speed));
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
   * onoff.pump, which is evap-only and added or removed by the device from the
   * live mode rather than fixed at pairing time (ZoneDevice#syncPumpCapability).
   *
   * Read from the manifest rather than kept as a second list here. The
   * capabilities returned by onPairListDevices() override the manifest, so a
   * hand-maintained copy drifts silently: three capabilities added to
   * driver.compose.json and not here paired devices without them, which then
   * threw `Invalid Capability` on every sync.
   */
  private pairingCapabilities(): string[] {
    return (this.manifest.capabilities as string[])
      .filter((capability) => capability !== 'onoff.pump');
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
