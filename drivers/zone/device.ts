'use strict';

import Homey from 'homey';
import type { RinnaiTouchApp, RinnaiSyncableDevice } from '../../app';
import type { RinnaiMode, RinnaiZone } from '../../lib/rinnai/RinnaiConnection';

class ZoneDevice extends Homey.Device implements RinnaiSyncableDevice {

  private get app(): RinnaiTouchApp {
    return this.homey.app as unknown as RinnaiTouchApp;
  }

  private get zone(): RinnaiZone {
    return this.getData().zone;
  }

  private lastOnoffTitle: string | undefined;

  private pumpListenerRegistered = false;

  private pumpCapabilityPending = false;

  async onInit() {
    if (!this.hasCapability('rt_zone_active')) {
      // Migration: devices paired before this status capability existed.
      await this.addCapability('rt_zone_active');
    }

    this.registerCapabilityListener('target_temperature', async (value: number) => {
      await this.app.rinnai.setTargetTemperature(value, this.zone);
    });

    // Mode-aware on/off, mirroring how the physical wall controllers behave:
    // - in evap, each zone has its own cooler, so this toggles that zone only.
    // - in heat/cool, power is unit-wide, so this switches the whole system.
    //   The sibling zone devices reflect the change via the app's fan-out.
    this.registerCapabilityListener('onoff', async (value: boolean) => {
      if (this.app.rinnai.mode === 'evap') {
        await this.app.rinnai.setUserEnabled(value, this.zone);
      } else {
        await this.app.rinnai.setOn(value);
      }
    });

    // Mode and fan are unit-wide, and the fan is genuinely functional in
    // every mode (in heat/cool it's a real "fan only, no heat" toggle, not
    // just an evap thing), so both are always present. They're duplicated
    // onto every zone device (like every physical controller carries these
    // buttons); setting one propagates to the others via syncFromService().
    this.registerCapabilityListener('rt_operating_mode', async (value: RinnaiMode) => {
      await this.app.rinnai.setMode(value);
    });

    this.registerCapabilityListener('onoff.fan', async (value: boolean) => {
      await this.app.rinnai.setFanState(value);
    });

    this.registerCapabilityListener('rt_fan_speed', async (value: number) => {
      await this.app.rinnai.setFanSpeed(value);
    });

    this.ensurePumpListener();

    try {
      // Await the shared connection's initial status fetch so the first sync
      // reflects real state rather than whatever Homey persisted last run.
      await this.app.rinnai.init();
      this.syncFromService();
    } catch (err) {
      this.error('Failed to reach the Brivis Touch module', err);
      await this.setUnavailable('Waiting for connection to the Brivis Touch module').catch(() => undefined);
    }
  }

  syncFromService(): void {
    this.setAvailable().catch(() => undefined);

    const { rinnai } = this.app;
    const { zone } = this;

    const currentTemp = rinnai.getCurrentTemperature(zone);
    if (currentTemp !== undefined) {
      this.setCapabilityValue('measure_temperature', currentTemp).catch((err) => this.error(err));
    }

    this.setCapabilityValue('rt_zone_active', rinnai.getAutoEnabled(zone)).catch((err) => this.error(err));

    const targetTemp = rinnai.getTargetTemperature(zone);
    if (targetTemp !== undefined) {
      this.setCapabilityValue('target_temperature', targetTemp).catch((err) => this.error(err));
    }

    // Mirror the mode-aware write above: in evap report this zone's own state,
    // otherwise report the unit-wide on/off. The title follows suit so the
    // toggle never claims to be system-wide when it's actually per-zone.
    const isEvap = rinnai.mode === 'evap';
    const on = isEvap ? rinnai.getUserEnabled(zone) : rinnai.isOn;
    this.setCapabilityValue('onoff', on).catch((err) => this.error(err));

    const onoffTitle = isEvap ? 'Zone Power' : 'System Power';
    if (this.lastOnoffTitle !== onoffTitle) {
      this.lastOnoffTitle = onoffTitle;
      this.setCapabilityOptions('onoff', { title: { en: onoffTitle } }).catch((err) => this.error(err));
    }

    if (rinnai.mode !== undefined) {
      this.setCapabilityValue('rt_operating_mode', rinnai.mode).catch((err) => this.error(err));
    }

    this.setCapabilityValue('onoff.fan', rinnai.getFanState()).catch((err) => this.error(err));

    const fanSpeed = rinnai.getFanSpeed();
    if (!Number.isNaN(fanSpeed)) {
      this.setCapabilityValue('rt_fan_speed', fanSpeed).catch((err) => this.error(err));
    }

    // The pump only exists/means anything in evap - show it only while the
    // system is actually in that mode, not just because the hardware
    // supports it (that's checked too, via hasEvaporative).
    this.syncPumpCapability(rinnai.hasEvaporative && isEvap);
  }

  /**
   * Adds/removes the pump capability to match `shouldShow`. Fire-and-forget
   * (syncFromService is synchronous and runs often), with a pending guard so
   * overlapping syncs don't attempt concurrent add/remove calls on the same
   * capability - Homey documents these as expensive and they're not safe to
   * race.
   */
  private syncPumpCapability(shouldShow: boolean): void {
    const has = this.hasCapability('onoff.pump');
    if (shouldShow === has || this.pumpCapabilityPending) {
      return;
    }

    this.pumpCapabilityPending = true;
    const task = shouldShow
      ? this.addCapability('onoff.pump').then(() => this.ensurePumpListener())
      : this.removeCapability('onoff.pump').then(() => {
        this.pumpListenerRegistered = false;
      });

    task
      .catch((err) => this.error(err))
      .finally(() => {
        this.pumpCapabilityPending = false;
        if (shouldShow && this.hasCapability('onoff.pump')) {
          this.setCapabilityValue('onoff.pump', this.app.rinnai.getPumpState()).catch((err) => this.error(err));
        }
      });
  }

  private ensurePumpListener(): void {
    if (this.pumpListenerRegistered || !this.hasCapability('onoff.pump')) {
      return;
    }
    this.registerCapabilityListener('onoff.pump', async (value: boolean) => {
      await this.app.rinnai.setPumpState(value);
    });
    this.pumpListenerRegistered = true;
  }

}

module.exports = ZoneDevice;
export type { ZoneDevice };
