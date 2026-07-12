'use strict';

import Homey from 'homey';
import type { RinnaiTouchApp } from '../../app';
import type { RinnaiZone } from '../../lib/rinnai/RinnaiConnection';

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

class ZoneDriver extends Homey.Driver {

  private get app(): RinnaiTouchApp {
    return this.homey.app as unknown as RinnaiTouchApp;
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
export type { ZoneDriver };
