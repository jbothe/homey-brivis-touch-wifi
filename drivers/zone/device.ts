'use strict';

import Homey from 'homey';
import type { RinnaiTouchApp, RinnaiSyncableDevice } from '../../app';
import type { RinnaiMode, RinnaiZone } from '../../lib/rinnai/RinnaiConnection';

// Must match the rt_fan_speed capability definition (.homeycompose/capabilities).
const FAN_SPEED_MIN = 1;
const FAN_SPEED_MAX = 16;

class ZoneDevice extends Homey.Device implements RinnaiSyncableDevice {

  private get app(): RinnaiTouchApp {
    return this.homey.app as unknown as RinnaiTouchApp;
  }

  private get zone(): RinnaiZone {
    return this.getData().zone;
  }

  private lastOnoffTitle: string | undefined;

  // undefined until the first real sync, so pairing/boot doesn't fire a
  // spurious "changed" trigger for the initial value.
  private lastMode: RinnaiMode | undefined;

  private lastZoneActive: boolean | undefined;

  private pumpListenerRegistered = false;

  private pumpCapabilityPending = false;

  async onInit() {
    if (!this.hasCapability('rt_zone_active')) {
      // Migration: devices paired before this status capability existed.
      await this.addCapability('rt_zone_active');
    }

    // Same migration for the read-only status capabilities added alongside it.
    // Ordered as listed so they appear together in the device UI.
    for (const capability of ['rt_control_mode', 'rt_schedule_override', 'rt_schedule_period']) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }

    // capabilitiesOptions.step is 1 (see driver.compose.json) and the device
    // detail thermostat UI respects that, but the Homey dashboard widget's
    // +/- arrows ignore it and always step by 0.5. That's a platform bug,
    // not something fixable here: https://github.com/athombv/homey-apps-sdk-issues/issues/448
    this.registerCapabilityListener('target_temperature', async (value: number) => {
      await this.command(`set target temperature to ${value}`,
        () => this.app.rinnai.setTargetTemperature(value, this.zone));
    });

    // Mode-aware on/off, mirroring how the physical wall controllers behave:
    // - in evap on a multi-setpoint system, each zone has its own cooler, so
    //   this toggles that zone only.
    // - otherwise power is unit-wide, so this switches the whole system. The
    //   sibling zone devices reflect the change via the app's fan-out.
    this.registerCapabilityListener('onoff', async (value: boolean) => {
      if (this.usesZoneSwitch) {
        await this.command(`turn zone ${value ? 'on' : 'off'}`,
          () => this.app.rinnai.setUserEnabled(value, this.zone));
      } else {
        await this.command(`turn system ${value ? 'on' : 'off'}`,
          () => this.app.rinnai.setOn(value));
      }
    });

    // Mode and fan are unit-wide, and the fan is genuinely functional in
    // every mode (in heat/cool it's a real "fan only, no heat" toggle, not
    // just an evap thing), so both are always present. They're duplicated
    // onto every zone device (like every physical controller carries these
    // buttons); setting one propagates to the others via syncFromService().
    this.registerCapabilityListener('rt_operating_mode', async (value: RinnaiMode) => {
      await this.command(`set mode to ${value}`, () => this.app.rinnai.setMode(value));
    });

    // In heat/cool this and `onoff` are two views of one tri-state protocol
    // field, so they read as a pair rather than independently: on + fan off is
    // heating, on + fan on is fan-only, off is off. Turning the fan off
    // therefore returns the unit to heating rather than shutting it down - see
    // RinnaiConnection#isOn.
    this.registerCapabilityListener('onoff.fan', async (value: boolean) => {
      await this.command(`turn fan ${value ? 'on' : 'off'}`,
        () => this.app.rinnai.setFanState(value));
    });

    this.registerCapabilityListener('rt_fan_speed', async (value: number) => {
      await this.command(`set fan speed to ${value}`, () => this.app.rinnai.setFanSpeed(value));
    });

    this.ensurePumpListener();

    try {
      // Await the shared connection's initial status fetch so the first sync
      // reflects real state rather than whatever Homey persisted last run.
      await this.app.rinnai.init();
      this.syncFromService();
    } catch (err) {
      this.error('Failed to reach the Brivis Touch Wi-Fi module', err);
      await this.setUnavailable('Waiting for connection to the Brivis Touch Wi-Fi module').catch(() => undefined);
    }
  }

  /**
   * Whether `onoff` controls this zone alone rather than the whole unit. Only
   * multi-setpoint evap gives each zone its own cooler; everywhere else - and
   * on a single-setpoint system in any mode - power is unit-wide. Without the
   * multi-setpoint test this resolved the zone switch to `ECOM.GSO.ZUUE`, a
   * path that does not exist, so the toggle did nothing at all.
   */
  private get usesZoneSwitch(): boolean {
    const { rinnai } = this.app;
    return rinnai.mode === 'evap' && rinnai.hasMultiSetPoint;
  }

  syncFromService(): void {
    const { rinnai } = this.app;
    const { zone } = this;

    const currentTemp = rinnai.getCurrentTemperature(zone);
    if (currentTemp !== undefined) {
      this.setCapabilityValue('measure_temperature', currentTemp).catch((err) => this.error(err));
    }

    // getSystemActive() rather than getAutoEnabled(): they are the same thing
    // on multi-setpoint hardware, but on a single-setpoint system AutoEnabled
    // resolves to a per-zone path that does not exist there, so this capability
    // sat permanently false. getSystemActive() falls back to the unit-wide flag.
    const zoneActive = rinnai.getSystemActive(zone);
    this.setCapabilityValue('rt_zone_active', zoneActive).catch((err) => this.error(err));
    if (this.lastZoneActive !== undefined && this.lastZoneActive !== zoneActive) {
      this.homey.flow.getDeviceTriggerCard('rt_zone_active_changed')
        .trigger(this, { rt_zone_active: zoneActive }, {})
        .catch((err) => this.error(err));
    }
    this.lastZoneActive = zoneActive;

    // Read-only reflections of what the wall controller is set to. Each reads
    // undefined where the module does not report it - schedule period in evap
    // mode, and all three before the first status frame - and null is how a
    // Homey capability says "unknown", as opposed to holding a stale value.
    this.setCapabilityValue('rt_control_mode',
      rinnai.getControlMode(zone) ?? null).catch((err) => this.error(err));
    this.setCapabilityValue('rt_schedule_override',
      rinnai.getScheduleOverride(zone) ?? null).catch((err) => this.error(err));
    this.setCapabilityValue('rt_schedule_period',
      rinnai.getSchedulePeriod(zone) ?? null).catch((err) => this.error(err));

    const targetTemp = rinnai.getTargetTemperature(zone);
    if (targetTemp !== undefined) {
      this.setCapabilityValue('target_temperature', targetTemp).catch((err) => this.error(err));
    }

    // Mirror the mode-aware write above: report this zone's own state where the
    // toggle controls the zone, the unit-wide on/off otherwise. The title
    // follows suit so it never claims to be system-wide when it's per-zone.
    const isEvap = rinnai.mode === 'evap';
    const perZone = this.usesZoneSwitch;
    const on = perZone ? rinnai.getUserEnabled(zone) : rinnai.isOn;
    this.setCapabilityValue('onoff', on).catch((err) => this.error(err));

    const onoffTitle = perZone ? 'Zone Power' : 'System Power';
    if (this.lastOnoffTitle !== onoffTitle) {
      this.lastOnoffTitle = onoffTitle;
      this.setCapabilityOptions('onoff', { title: { en: onoffTitle } }).catch((err) => this.error(err));
    }

    if (rinnai.mode !== undefined) {
      this.setCapabilityValue('rt_operating_mode', rinnai.mode).catch((err) => this.error(err));
      if (this.lastMode !== undefined && this.lastMode !== rinnai.mode) {
        this.homey.flow.getDeviceTriggerCard('rt_operating_mode_changed')
          .trigger(this, {}, { rt_operating_mode: rinnai.mode })
          .catch((err) => this.error(err));
      }
      this.lastMode = rinnai.mode;
    }

    this.setCapabilityValue('onoff.fan', rinnai.getFanState()).catch((err) => this.error(err));

    // Range-checked, not just NaN-checked: the capability declares 1-16, and
    // the module reports 0 with the fan stopped. Writing an out-of-range value
    // makes Homey reject the whole set.
    const fanSpeed = rinnai.getFanSpeed();
    if (Number.isFinite(fanSpeed) && fanSpeed >= FAN_SPEED_MIN && fanSpeed <= FAN_SPEED_MAX) {
      this.setCapabilityValue('rt_fan_speed', fanSpeed).catch((err) => this.error(err));
    }

    // The pump only exists/means anything in evap - show it only while the
    // system is actually in that mode, not just because the hardware
    // supports it (that's checked too, via hasEvaporative).
    this.syncPumpCapability(rinnai.hasEvaporative && isEvap);
  }

  /**
   * Runs a capability write, logging the failure exactly once. This is the
   * outermost handler on the command path - the service and repository below it
   * propagate rather than log, so without this a rejected command leaves nothing
   * in the app log at all.
   *
   * The rethrow is load-bearing: it is what makes Homey revert the optimistic
   * value instead of leaving a setpoint on screen the unit never accepted.
   */
  private async command(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.error(`Failed to ${what}`, error);
      throw error;
    }
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
      await this.command(`turn pump ${value ? 'on' : 'off'}`,
        () => this.app.rinnai.setPumpState(value));
    });
    this.pumpListenerRegistered = true;
  }

}

module.exports = ZoneDevice;
