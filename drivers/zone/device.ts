'use strict';

import Homey from 'homey';
import type { RinnaiTouchApp, RinnaiSyncableDevice } from '../../app';
import type { RinnaiEvapControl, RinnaiMode, RinnaiZone } from '../../lib/rinnai/RinnaiConnection';

// Must match the rt_fan_speed capability definition (.homeycompose/capabilities).
const FAN_SPEED_MIN = 1;
const FAN_SPEED_MAX = 16;

// Set at runtime rather than in driver.compose.json, because which one applies
// depends on the mode the unit is in. Translated in step with the manifests: a
// title left in English here would be the one untranslated string in an
// otherwise translated app, which the App Store guidelines call out (1.11).
const ONOFF_TITLES = {
  zone: {
    en: 'Zone Power', nl: 'Zone aan/uit', fr: 'Zone marche/arrêt', de: 'Zone Ein/Aus',
  },
  system: {
    en: 'System Power', nl: 'Systeem aan/uit', fr: 'Système marche/arrêt', de: 'System Ein/Aus',
  },
};

class ZoneDevice extends Homey.Device implements RinnaiSyncableDevice {

  private get app(): RinnaiTouchApp {
    return this.homey.app as unknown as RinnaiTouchApp;
  }

  private get zone(): RinnaiZone {
    return this.getData().zone;
  }

  private lastOnoffTitle: string | undefined;

  private lastZoneActive: boolean | undefined;

  // Listeners on capabilities that come and go with the mode. Homey drops a
  // capability's listener along with it, so each is re-registered on re-add.
  private readonly listenersRegistered = new Set<string>();

  // Capabilities with an add/remove in flight; see syncOptionalCapability().
  private readonly capabilitiesPending = new Set<string>();

  async onInit() {
    this.ensureOptionalListeners();

    // Mode-aware; see setPower().
    this.registerCapabilityListener('onoff', (value: boolean) => this.setPower(value));

    // The mode picker, and power too: Off / Heat / Cool / Evap. It's Homey's
    // own capability rather than ours because the dashboard thermostat widget
    // reads on/off from it - without it the unit showed as running when off.
    // Off is the same switch as onoff (per-zone in multi-setpoint evap, see
    // setPower()); a mode switches on as well as selecting it.
    await this.ensureThermostatMode();
    this.registerCapabilityListener('thermostat_mode', async (value: RinnaiMode | 'off') => {
      if (value === 'off') {
        await this.setPower(false);
        return;
      }
      const { rinnai } = this.app;
      if (rinnai.mode !== value) {
        await this.command(`set mode to ${value}`, () => rinnai.setMode(value));
        // setPower() picks zone vs system switch from the mode, and the status
        // it reads still has the old one until the next frame arrives.
        await this.command('read status after mode change', () => rinnai.refresh());
      }
      if (!this.powerState) {
        await this.setPower(true);
      }
    });

    // Mode (above) and fan are unit-wide, and the fan is genuinely functional
    // in every mode (in heat/cool it's a real "fan only, no heat" toggle, not
    // just an evap thing), so both are always present. They're duplicated
    // onto every zone device (like every physical controller carries these
    // buttons); setting one propagates to the others via syncFromService().
    //
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

  /**
   * Mode-aware on/off, mirroring how the physical wall controllers behave:
   * - in evap on a multi-setpoint system, each zone has its own cooler, so
   *   this toggles that zone only.
   * - otherwise power is unit-wide, so this switches the whole system. The
   *   sibling zone devices reflect the change via the app's fan-out.
   */
  private async setPower(value: boolean): Promise<void> {
    if (this.usesZoneSwitch) {
      await this.command(`turn zone ${value ? 'on' : 'off'}`,
        () => this.app.rinnai.setUserEnabled(value, this.zone));
    } else {
      await this.command(`turn system ${value ? 'on' : 'off'}`,
        () => this.app.rinnai.setOn(value));
    }
  }

  /** The read side of setPower(): what `onoff` reports. */
  private get powerState(): boolean {
    const { rinnai } = this.app;
    return this.usesZoneSwitch ? rinnai.getUserEnabled(this.zone) : rinnai.isOn;
  }

  /**
   * Devices paired before thermostat_mode was added to the driver don't get it
   * from the manifest, so add it here. The manifest's options - our values in
   * place of Homey's default auto/heat/cool/off - are applied on every init,
   * not only when adding, so devices that picked up an earlier value set get
   * the current one.
   *
   * thermostat_mode replaced the app's own rt_operating_mode, which is no
   * longer defined; devices paired while it was are stripped of it here.
   */
  private async ensureThermostatMode(): Promise<void> {
    try {
      if (this.hasCapability('rt_operating_mode')) {
        await this.removeCapability('rt_operating_mode');
      }
      if (!this.hasCapability('thermostat_mode')) {
        await this.addCapability('thermostat_mode');
      }
      const { capabilitiesOptions } = this.driver.manifest;
      await this.setCapabilityOptions('thermostat_mode', capabilitiesOptions.thermostat_mode);
    } catch (err) {
      this.error('Failed to set up thermostat_mode', err);
    }
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
    this.setOptionalValue('rt_control_mode', rinnai.getControlMode(zone) ?? null);
    this.setCapabilityValue('rt_schedule_override',
      rinnai.getScheduleOverride(zone) ?? null).catch((err) => this.error(err));
    this.setCapabilityValue('rt_schedule_period',
      rinnai.getSchedulePeriod(zone) ?? null).catch((err) => this.error(err));

    // Mirror the mode-aware write above: report this zone's own state where the
    // toggle controls the zone, the unit-wide on/off otherwise. The title
    // follows suit so it never claims to be system-wide when it's per-zone.
    const isEvap = rinnai.mode === 'evap';
    const modeKnown = rinnai.mode !== undefined;
    const perZone = this.usesZoneSwitch;
    const on = this.powerState;
    this.setCapabilityValue('onoff', on).catch((err) => this.error(err));

    // uiState is repeated here although the manifest sets it, so that devices
    // paired before it was added pick it up too: it makes onoff, not whichever
    // boolean Homey would otherwise choose, what the device tile shows as
    // on/off. onoff duplicates thermostat_mode's Off on the device screen, but
    // stays for the tile, the standard on/off Flow cards and voice assistants.
    // It isn't hidden because it can't be: Homey ignores uiComponent: null for
    // onoff on this device class, as it does for thermostat_mode.
    const onoffTitle = perZone ? 'zone' : 'system';
    if (this.lastOnoffTitle !== onoffTitle) {
      this.lastOnoffTitle = onoffTitle;
      this.setCapabilityOptions('onoff', { title: ONOFF_TITLES[onoffTitle], uiState: true })
        .catch((err) => this.error(err));
    }

    // Derived from the same state as onoff so the two can't disagree - see the
    // listener in onInit(). Left alone until the mode is known.
    if (rinnai.mode !== undefined && this.hasCapability('thermostat_mode')) {
      this.setCapabilityValue('thermostat_mode', on ? rinnai.mode : 'off').catch((err) => this.error(err));
    }

    this.setCapabilityValue('onoff.fan', rinnai.getFanState()).catch((err) => this.error(err));

    // Range-checked, not just NaN-checked: the capability declares 1-16, and
    // the module reports 0 with the fan stopped. Writing an out-of-range value
    // makes Homey reject the whole set. Not reported at all (NaN) is evap Auto,
    // where the Networker picks the speed and does not say what it picked -
    // unknown, rather than the last speed set in Manual.
    const fanSpeed = rinnai.getFanSpeed();
    if (Number.isNaN(fanSpeed)) {
      this.setCapabilityValue('rt_fan_speed', null).catch((err) => this.error(err));
    } else if (fanSpeed >= FAN_SPEED_MIN && fanSpeed <= FAN_SPEED_MAX) {
      this.setCapabilityValue('rt_fan_speed', fanSpeed).catch((err) => this.error(err));
    }

    // Which setpoint applies depends on the mode: a temperature in heat/cool, a
    // comfort level (1-16) in evap Auto, and none at all in evap Manual, where
    // the module rejects writes to it. rt_control_mode's Schedule/Manual reads
    // the same protocol field that is Auto/Manual in evap, so evap has its own
    // rt_evap_control rather than mislabelling it. All left alone until the
    // mode is known.
    //
    // The comfort level stays through Auto and Manual alike - unknown, and
    // refusing writes, in Manual - rather than coming and going with them. An
    // open device screen does not pick up an added or removed capability: a
    // just-added slider would not respond and a just-removed one stayed on
    // screen and failed when used, until the screen was reopened. Auto/Manual
    // is switched often; the heat/cool/evap changes that still add and remove
    // are not.
    if (modeKnown) {
      this.syncOptionalCapability('target_temperature', !isEvap);
      this.syncOptionalCapability('rt_control_mode', !isEvap);
      this.syncOptionalCapability('rt_evap_control', isEvap);
      this.syncOptionalCapability('rt_prewet', isEvap);
      this.syncOptionalCapability('rt_comfort_level', isEvap);
    }
    const targetTemp = rinnai.getTargetTemperature(zone);
    if (targetTemp !== undefined) {
      this.setOptionalValue('target_temperature', targetTemp);
    }
    this.setOptionalValue('rt_evap_control', rinnai.getEvapControl() ?? null);
    this.setOptionalValue('rt_prewet', rinnai.getPreWet() ?? null);
    this.setOptionalValue('rt_comfort_level', rinnai.getComfortLevel() ?? null);

    // The pump only exists/means anything in evap - show it only while the
    // system is actually in that mode, not just because the hardware
    // supports it (that's checked too, via hasEvaporative). In Auto it and
    // the fan speed stay visible but refuse writes: the Networker runs them.
    this.syncOptionalCapability('onoff.pump', rinnai.hasEvaporative && isEvap);
    this.setOptionalValue('onoff.pump', rinnai.getPumpState());
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
   * Adds/removes a mode-dependent capability to match `shouldShow`.
   * Fire-and-forget (syncFromService is synchronous and runs often), with a
   * pending guard so overlapping syncs don't attempt concurrent add/remove calls
   * on the same capability - Homey documents these as expensive and they're not
   * safe to race. The value is filled in by the next sync.
   */
  private syncOptionalCapability(id: string, shouldShow: boolean): void {
    if (shouldShow === this.hasCapability(id) || this.capabilitiesPending.has(id)) {
      return;
    }

    this.capabilitiesPending.add(id);
    const task = shouldShow
      ? this.addCapability(id).then(() => this.ensureOptionalListeners())
      : this.removeCapability(id).then(() => {
        this.listenersRegistered.delete(id);
      });

    task
      .catch((err) => this.error(err))
      .finally(() => {
        this.capabilitiesPending.delete(id);
        if (shouldShow && this.hasCapability(id)) {
          this.syncFromService();
        }
      });
  }

  /**
   * Writes a mode-dependent capability, skipping it while absent or while an
   * add/remove is in flight. hasCapability() alone is not enough: it still
   * reads true while a removal is pending, and the write then lands after it
   * as `Invalid Capability`. A skipped add is filled in by the sync that
   * syncOptionalCapability() runs once it completes.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private setOptionalValue(id: string, value: any): void {
    if (!this.hasCapability(id) || this.capabilitiesPending.has(id)) {
      return;
    }
    this.setCapabilityValue(id, value).catch((err) => this.error(err));
  }

  /** Registers the listener of each mode-dependent capability the device has. */
  private ensureOptionalListeners(): void {
    // capabilitiesOptions.step is 1 (see driver.compose.json) and the device
    // detail thermostat UI respects that, but the Homey dashboard widget's
    // +/- arrows ignore it and always step by 0.5. That's a platform bug,
    // not something fixable here: https://github.com/athombv/homey-apps-sdk-issues/issues/448
    this.ensureListener('target_temperature', async (value: number) => {
      await this.command(`set target temperature to ${value}`,
        () => this.app.rinnai.setTargetTemperature(value, this.zone));
    });

    this.ensureListener('rt_evap_control', async (value: RinnaiEvapControl) => {
      await this.command(`set cooler control to ${value}`,
        () => this.app.rinnai.setEvapControl(value));
    });

    this.ensureListener('rt_comfort_level', async (value: number) => {
      await this.command(`set comfort level to ${value}`,
        () => this.app.rinnai.setComfortLevel(value));
    });

    this.ensureListener('onoff.pump', async (value: boolean) => {
      await this.command(`turn pump ${value ? 'on' : 'off'}`,
        () => this.app.rinnai.setPumpState(value));
    });
  }

  private ensureListener(id: string, listener: Homey.Device.CapabilityCallback): void {
    if (this.listenersRegistered.has(id) || !this.hasCapability(id)) {
      return;
    }
    this.registerCapabilityListener(id, listener);
    this.listenersRegistered.add(id);
  }

}

module.exports = ZoneDevice;
