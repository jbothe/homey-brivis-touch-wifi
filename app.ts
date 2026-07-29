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
// Ceiling on the backoff below. Once the module is unreachable there is
// nothing to poll for, so this is purely how quickly we notice it coming back.
const POLL_BACKOFF_MAX_MS = 300000;
const UNAVAILABLE_MESSAGE = 'Lost connection to the Brivis Touch module';

export interface RinnaiSyncableDevice {
  syncFromService(): void;
}

class RinnaiTouchApp extends Homey.App {

  public rinnai!: RinnaiConnection;

  private pollTimer?: NodeJS.Timeout;

  private pollFailures = 0;

  private devicesUnavailable = false;

  private stopped = false;

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
    this.stopped = true;
    if (this.pollTimer) {
      this.homey.clearTimeout(this.pollTimer);
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
    this.scheduleNextPoll();
  }

  /**
   * Self-scheduling rather than setInterval: the delay has to grow while the
   * module is unreachable, and a poll that runs long must not have the next one
   * fire on top of it - every request funnels through one serialized connection.
   */
  private scheduleNextPoll(): void {
    if (this.stopped) {
      return;
    }
    this.pollTimer = this.homey.setTimeout(() => this.poll(), this.nextPollDelay());
  }

  /**
   * Steady state polls at the fixed interval. Once the module has stopped
   * answering, back off exponentially to POLL_BACKOFF_MAX_MS: a module whose
   * TCP listener has gone away (UDP discovery still answers, the connect gets
   * ECONNREFUSED) stays that way for hours, and retrying every 15 sec neither
   * brings it back nor tells us anything - it just buries the log. Each failed
   * poll costs three connect attempts, so the flat interval was ~17k connects
   * and ~69k log lines a day.
   */
  private nextPollDelay(): number {
    if (this.pollFailures < POLL_FAILURES_BEFORE_UNAVAILABLE) {
      return POLL_INTERVAL_MS;
    }
    const steps = this.pollFailures - POLL_FAILURES_BEFORE_UNAVAILABLE;
    return Math.min(POLL_INTERVAL_MS * 2 ** steps, POLL_BACKOFF_MAX_MS);
  }

  private async poll(): Promise<void> {
    try {
      await this.rinnai.refresh();
      this.onPollSucceeded();
      this.logState();
    } catch (error) {
      this.onPollFailed(error);
    } finally {
      this.scheduleNextPoll();
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
    this.pollFailures += 1;

    // Only the failures that are still telling us something get the stack. Once
    // the devices are marked unavailable the cause has been reported and every
    // subsequent poll fails identically, so keep it to one line.
    if (this.devicesUnavailable) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[poll] still unreachable (${this.pollFailures} failures): ${message}`);
      return;
    }

    this.error('Poll failed', error);

    if (this.pollFailures < POLL_FAILURES_BEFORE_UNAVAILABLE) {
      return;
    }

    // Without this the devices keep serving their last known values as if live,
    // indefinitely - the app only ever marked them unavailable at boot.
    this.devicesUnavailable = true;
    this.error(`No response from the module after ${this.pollFailures} polls, marking devices unavailable`
      + `, backing off to ${Math.round(POLL_BACKOFF_MAX_MS / 1000)}s between retries`);
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
