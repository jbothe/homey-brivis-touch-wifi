'use strict';

import Homey from 'homey';
import { RinnaiConnection } from './lib/rinnai/RinnaiConnection';

const DRIVER_IDS = ['zone'] as const;
const INIT_RETRY_MS = 30000;
// The module only streams status while a connection is open, and the
// connection idle-closes after a few seconds. Poll to pick up changes made
// outside Homey (wall controllers, phone app) while the app is idle.
const POLL_INTERVAL_MS = 15000;
// A single failed poll is routine (a command holding the queue, a dropped
// frame). Only after this many consecutive failures - about 45 sec - do the
// devices stop being trustworthy enough to keep showing their last values.
const POLL_FAILURES_BEFORE_UNAVAILABLE = 3;
const UNAVAILABLE_MESSAGE = 'Lost connection to the Brivis Touch module';

export interface RinnaiSyncableDevice {
  syncFromService(): void;
}

class RinnaiTouchApp extends Homey.App {

  public rinnai!: RinnaiConnection;

  private pollTimer?: NodeJS.Timeout;

  private polling = false;

  private pollFailures = 0;

  private devicesUnavailable = false;

  async onInit() {
    // No address override for v1 - the module is always found via UDP
    // broadcast discovery (see lib/rinnai/RinnaiTouchUdp.js).
    this.rinnai = new RinnaiConnection(this.log.bind(this));

    this.rinnai.on('updated', () => this.syncDevices());
    this.rinnai.on('mode', () => this.syncDevices());

    this.connectWithRetry();

    this.log('RinnaiTouchApp has been initialized');
  }

  async onUninit() {
    if (this.pollTimer) {
      this.homey.clearInterval(this.pollTimer);
    }
    await this.rinnai.close();
  }

  /**
   * The physical module may not be reachable yet when the app boots (e.g. it
   * lost power alongside Homey). Keep retrying in the background rather than
   * failing onInit(), since pairing/device code also calls rinnai.init() and
   * will succeed as soon as the module is reachable. Once connected, start
   * polling for out-of-band changes.
   */
  private connectWithRetry(): void {
    this.rinnai.init()
      .then(() => this.startPolling())
      .catch((error) => {
        this.error('Failed to connect to Rinnai Touch module, retrying in 30s', error);
        this.homey.setTimeout(() => this.connectWithRetry(), INIT_RETRY_MS);
      });
  }

  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = this.homey.setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    // Skip if the previous poll is still running (e.g. a slow reconnect) so
    // requests don't pile up on the single serialized connection.
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      await this.rinnai.refresh();
      this.onPollSucceeded();
      this.logState();
    } catch (error) {
      this.onPollFailed(error);
    } finally {
      this.polling = false;
    }
  }

  private onPollSucceeded(): void {
    this.pollFailures = 0;

    if (!this.devicesUnavailable) {
      return;
    }
    this.devicesUnavailable = false;
    this.log('Reconnected to the Brivis Touch module');

    // syncFromService() also marks devices available, but only runs when the
    // status actually changed - and a module that comes back reporting exactly
    // what it reported before would otherwise stay unavailable forever.
    this.forEachDevice((device) => {
      device.setAvailable().catch((err) => this.error(err));
    });
  }

  private onPollFailed(error: unknown): void {
    this.error('Poll failed', error);

    this.pollFailures += 1;
    if (this.devicesUnavailable || this.pollFailures < POLL_FAILURES_BEFORE_UNAVAILABLE) {
      return;
    }

    // Without this the devices keep serving their last known values as if live,
    // indefinitely - the app only ever marked them unavailable at boot.
    this.devicesUnavailable = true;
    this.error(`No response from the module after ${this.pollFailures} polls, marking devices unavailable`);
    this.forEachDevice((device) => {
      device.setUnavailable(UNAVAILABLE_MESSAGE).catch((err) => this.error(err));
    });
  }

  private logState(): void {
    const { rinnai } = this;

    // Print every raw per-zone field, not just the ones a capability
    // currently consumes - userEnabled/autoEnabled don't mean the same
    // thing on every hardware config (see RinnaiConnection.getUserEnabled),
    // so this is diagnostic: it lets us see which field actually tracks
    // reality before wiring more of it into capabilities.
    const zones = rinnai.controllers
      .map((zone) => {
        const target = rinnai.getTargetTemperature(zone);
        const current = rinnai.getCurrentTemperature(zone);
        const userEnabled = rinnai.getUserEnabled(zone);
        const autoEnabled = rinnai.getAutoEnabled(zone);
        const systemActive = rinnai.getSystemActive(zone);
        const controlMode = rinnai.getControlMode(zone);
        const scheduleOverride = rinnai.getScheduleOverride(zone);
        return `${zone}(${rinnai.getZoneName(zone)}): `
          + `target=${target} current=${current} `
          + `userEnabled=${userEnabled} autoEnabled=${autoEnabled} systemActive=${systemActive} `
          + `controlMode=${controlMode} scheduleOverride=${scheduleOverride}`;
      })
      .join(' | ');

    const pump = rinnai.hasEvaporative ? ` pump=${rinnai.getPumpState()}` : '';

    this.log(`[poll] mode=${rinnai.mode} on=${rinnai.isOn} fan=${rinnai.getFanState()} fanSpeed=${rinnai.getFanSpeed()}${pump} || ${zones}`);
  }

  private syncDevices(): void {
    this.forEachDevice((device) => {
      (device as unknown as RinnaiSyncableDevice).syncFromService();
    });
  }

  private forEachDevice(fn: (device: Homey.Device) => void): void {
    for (const driverId of DRIVER_IDS) {
      let devices: Homey.Device[];
      try {
        devices = this.homey.drivers.getDriver(driverId).getDevices();
      } catch (error) {
        continue;
      }

      for (const device of devices) {
        try {
          fn(device);
        } catch (error) {
          this.error(error);
        }
      }
    }
  }

}

module.exports = RinnaiTouchApp;
export type { RinnaiTouchApp };
