'use strict';

import Homey from 'homey';
import { RinnaiConnection } from './lib/rinnai/RinnaiConnection';

const DRIVER_IDS = ['zone'] as const;
const INIT_RETRY_MS = 30000;
// The module only streams status while a connection is open, and the
// connection idle-closes after a few seconds. Poll to pick up changes made
// outside Homey (wall controllers, phone app) while the app is idle.
const POLL_INTERVAL_MS = 15000;

export interface RinnaiSyncableDevice {
  syncFromService(): void;
}

class RinnaiTouchApp extends Homey.App {

  public rinnai!: RinnaiConnection;

  private pollTimer?: NodeJS.Timeout;

  private polling = false;

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
      this.logState();
    } catch (error) {
      this.error('Poll failed', error);
    } finally {
      this.polling = false;
    }
  }

  private logState(): void {
    const { rinnai } = this;

    // Print every raw per-zone field, not just the ones a capability
    // currently consumes - userEnabled/autoEnabled don't mean the same
    // thing on every hardware config (see RinnaiConnection.getUserEnabled),
    // so this is diagnostic: it lets us see which field actually tracks
    // reality before wiring more of it into capabilities.
    const zones = rinnai.controllers
      .map((zone) => `${zone}(${rinnai.getZoneName(zone)}): target=${rinnai.getTargetTemperature(zone)} current=${rinnai.getCurrentTemperature(zone)} userEnabled=${rinnai.getUserEnabled(zone)} autoEnabled=${rinnai.getAutoEnabled(zone)} systemActive=${rinnai.getSystemActive(zone)} controlMode=${rinnai.getControlMode(zone)} scheduleOverride=${rinnai.getScheduleOverride(zone)}`)
      .join(' | ');

    const pump = rinnai.hasEvaporative ? ` pump=${rinnai.getPumpState()}` : '';

    this.log(`[poll] mode=${rinnai.mode} on=${rinnai.isOn} fan=${rinnai.getFanState()} fanSpeed=${rinnai.getFanSpeed()}${pump} || ${zones}`);
  }

  private syncDevices(): void {
    for (const driverId of DRIVER_IDS) {
      let devices: Homey.Device[];
      try {
        devices = this.homey.drivers.getDriver(driverId).getDevices();
      } catch (error) {
        continue;
      }

      for (const device of devices as unknown as RinnaiSyncableDevice[]) {
        try {
          device.syncFromService();
        } catch (error) {
          this.error(error);
        }
      }
    }
  }

}

module.exports = RinnaiTouchApp;
export type { RinnaiTouchApp };
