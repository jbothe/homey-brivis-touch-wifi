'use strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RinnaiTouchRepository = require('./RinnaiTouchRepository');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RinnaiTouchService = require('./RinnaiTouchService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Logger = require('./Logger');

export type RinnaiMode = 'heat' | 'cool' | 'evap';
export type RinnaiZone = 'U' | 'A' | 'B' | 'C' | 'D';

export interface RinnaiConnectionOptions {
  address?: string;
  port?: number;

  /**
   * How long to hold the connection open after the request queue drains, in ms.
   * The module accepts one TCP client at a time, so this is the window in which
   * other clients (the phone app, a wall controller's app) are locked out.
   * Negative keeps the connection open indefinitely, 0 closes immediately.
   *
   * Was named `connectionTimeout`, which it never was: connect attempts are
   * bounded inside RinnaiTouchTcp, and this value has no bearing on them.
   *
   * Upstream's 5000 came from a HomeKit plugin, where user interactions arrive
   * in bursts and holding the socket open saves a reconnect between them. This
   * app mostly polls on a 15 sec timer, so almost all of that window was spent
   * idle - measured at a 39% duty cycle on the module's single connection slot,
   * i.e. locked out roughly two seconds in every five, around the clock.
   *
   * 1500 halves that to ~18% at no cost. It cannot go much lower: a command
   * issues a read and then a write as two queued requests, and the queue drains
   * between them. Anything under `closeConnectionDelay` (1100) lets the close
   * land in that gap, so the command reconnects mid-flight - measured at 1.7 sec
   * per command against 100 ms here.
   */
  idleCloseDelay?: number;

  /**
   * How long to wait *after* closing the socket before treating the connection
   * as closed, in ms - the module needs a moment to free its single connection
   * slot before it will accept a new one.
   */
  closeConnectionDelay?: number;

  /**
   * Ceiling on a single connect attempt, in ms, covering UDP discovery, the TCP
   * handshake and the module's first status frame. Left at RinnaiTouchTcp's
   * default when unset.
   *
   * This is a backstop, not the primary detector - keep it above the socket
   * idle timeout (5 sec), which catches a module that accepts the connection
   * and then goes quiet. Setting it lower just makes that case report as a
   * plain timeout instead.
   */
  connectTimeout?: number;

  debug?: boolean;
}

const MODE_TO_STRING: Record<number, RinnaiMode> = { 0: 'heat', 1: 'cool', 2: 'evap' };
const STRING_TO_MODE: Record<RinnaiMode, number> = { heat: 0, cool: 1, evap: 2 };

export type RinnaiControlMode = 'manual' | 'schedule';
const CONTROL_MODE_TO_STRING: Record<number, RinnaiControlMode> = { 0: 'manual', 1: 'schedule' };

export type RinnaiScheduleOverride = 'none' | 'advance' | 'operation';
const SCHEDULE_OVERRIDE_TO_STRING: Record<number, RinnaiScheduleOverride> = { 0: 'none', 1: 'advance', 2: 'operation' };

// How old the last status frame may be before refresh() calls the read a
// failure. A successful read returns just after a frame arrives, and the
// module streams roughly one a second while connected, so anything this old
// means the read never landed. Generous enough to cover a reconnect
// (discovery + handshake) inside a single poll.
const STALE_STATUS_MS = 10000;

/**
 * Thin typed wrapper around the vendored RinnaiTouchRepository/RinnaiTouchService
 * (adapted from homebridge-rinnai-touch-plugin, see NOTICE.md). This is the only
 * class the rest of the app talks to - drivers/devices never touch the vendored
 * files directly.
 *
 * Every setX() method rejects if the module does not acknowledge the command
 * (three attempts, then give up). Capability listeners depend on that: a
 * rejection is what makes Homey revert the optimistic value instead of showing
 * a setpoint the unit never accepted.
 */
export class RinnaiConnection {
  // The vendored files have no type declarations (see NOTICE.md) - `any` is
  // the honest type here, not a shortcut. Everything below re-exposes their
  // surface with real types, so untyped-ness never leaks past this file.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly service: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly repository: any;

  private initPromise: Promise<void> | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(logFn: (...args: any[]) => void, options: RinnaiConnectionOptions = {}) {
    const log = new Logger(logFn, options.debug ?? false);
    const settings = {
      address: options.address,
      port: options.port,
      idleCloseDelay: options.idleCloseDelay ?? 1500,
      closeConnectionDelay: options.closeConnectionDelay ?? 1100,
      connectTimeout: options.connectTimeout,
    };

    this.repository = new RinnaiTouchRepository(log, settings);
    this.service = new RinnaiTouchService(log, this.repository);
  }

  /**
   * Safe to call repeatedly (e.g. once from app.onInit() and again from a
   * driver's pairing flow) - only calls the underlying service.init() once
   * a call actually succeeds, so the 'status' listener it registers is never
   * duplicated. A failed attempt is not cached, so the next call retries.
   */
  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.service.init().catch((error: unknown) => {
        this.initPromise = null;
        throw error;
      });
    }
    await this.initPromise;
  }

  /**
   * Force a fresh status read from the module. Used for polling so that
   * changes made outside Homey (wall controllers, phone app) are picked up
   * while the app is otherwise idle. The underlying service re-emits
   * 'updated' if anything actually changed.
   *
   * The service swallows its own read errors (see updateStates), so a failed
   * poll is detected here by checking that a status frame actually arrived
   * rather than by catching - otherwise a module that has been offline for
   * hours looks exactly like one where nothing has changed.
   */
  async refresh(): Promise<void> {
    await this.service.updateStates();

    const timestamp: number | undefined = this.repository.lastStatusTimestamp;
    if (timestamp === undefined || Date.now() - timestamp > STALE_STATUS_MS) {
      throw new Error('No status received from the Rinnai Touch module');
    }
  }

  async close(): Promise<void> {
    await this.repository.closeConnection();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'updated' | 'mode', listener: (...args: any[]) => void): void {
    this.service.on(event, listener);
  }

  get hasHeater(): boolean {
    return this.service.hasHeater;
  }

  get hasCooler(): boolean {
    return this.service.hasCooler;
  }

  get hasEvaporative(): boolean {
    return this.service.hasEvaporative;
  }

  get hasMultiSetPoint(): boolean {
    return this.service.hasMultiSetPoint;
  }

  get controllers(): RinnaiZone[] {
    return this.service.controllers;
  }

  get zones(): RinnaiZone[] {
    return this.service.zones;
  }

  get mode(): RinnaiMode | undefined {
    return MODE_TO_STRING[this.service.mode];
  }

  /**
   * Whether the unit is running at all - heating/cooling *or* fan-only. In
   * heat/cool this and getFanState() read the same tri-state protocol field
   * (`{mode}.OOP.ST`: `N` heat/cool, `Z` fan only, `F` off), so together they
   * describe it without overlapping:
   *
   *   isOn && !fan -> heating/cooling      isOn && fan -> fan only
   *   !isOn        -> off
   *
   * Distinct again from getSystemActive()/getAutoEnabled(), which report
   * whether the unit is *actively* heating/cooling at this moment rather than
   * what it has been switched to.
   */
  get isOn(): boolean {
    return this.service.getState();
  }

  /**
   * The module's last raw status payload: `[{ SYST: ... }, { HGOM|CGOM|ECOM:
   * ... }]`. Diagnostic only - everything the app acts on goes through the
   * typed getters above. Exposed because the protocol path table is reverse
   * engineered, so a reading that disagrees with the wall controller can only
   * be resolved by looking at what the module actually sent.
   */
  get rawStatus(): Record<string, unknown>[] | undefined {
    return this.repository.lastStatus;
  }

  getZoneName(zone: RinnaiZone): string {
    return this.service.getZoneName(zone);
  }

  getCurrentTemperature(zone: RinnaiZone): number | undefined {
    return this.service.getCurrentTemperature(zone);
  }

  getTargetTemperature(zone: RinnaiZone = 'U'): number | undefined {
    return this.service.getTargetTemperature(zone);
  }

  /**
   * Raw "user enabled" flag. Not necessarily meaningful for multi-setpoint
   * heat/cool zones on all hardware - see setUserEnabled() below. Exposed
   * for diagnostics; prefer isOn/getAutoEnabled for actual on/off state.
   */
  getUserEnabled(zone: RinnaiZone): boolean {
    return this.service.getUserEnabled(zone);
  }

  /**
   * Whether this zone is *currently* actively heating/cooling/enabled right
   * now (as opposed to isOn, which is whether the user switched the system
   * on at all). For multi-setpoint installations this is what the original
   * plugin uses as the per-zone "active" status.
   */
  getAutoEnabled(zone: RinnaiZone): boolean {
    return this.service.getAutoEnabled(zone);
  }

  getSystemActive(zone: RinnaiZone): boolean {
    return this.service.getSystemActive(zone);
  }

  getControlMode(zone: RinnaiZone = 'U'): RinnaiControlMode | undefined {
    return CONTROL_MODE_TO_STRING[this.service.getControlMode(zone)];
  }

  getScheduleOverride(zone: RinnaiZone): RinnaiScheduleOverride | undefined {
    return SCHEDULE_OVERRIDE_TO_STRING[this.service.getScheduleOverride(zone)];
  }

  getFanState(): boolean {
    return this.service.getFanState();
  }

  getFanSpeed(): number {
    return this.service.getFanSpeed();
  }

  getPumpState(): boolean {
    return this.service.getPumpState();
  }

  async setMode(mode: RinnaiMode): Promise<void> {
    await this.service.setMode(STRING_TO_MODE[mode]);
  }

  /**
   * Rounded rather than truncated: the capability declares a step of 1, but the
   * Homey dashboard widget's +/- arrows step by 0.5 regardless (see
   * drivers/zone/device.ts). The service parseInt()s what it is given, so 20.5
   * truncated back to 20 and every second press of "+" appeared to do nothing.
   */
  async setTargetTemperature(value: number, zone: RinnaiZone = 'U'): Promise<void> {
    await this.service.setTargetTemperature(Math.round(value), zone);
  }

  async setOn(value: boolean): Promise<void> {
    await this.service.setState(value);
  }

  /**
   * Per-zone on/off. Only valid on multi-setpoint installations (this app's
   * only supported configuration) when the current mode is 'evap' - the
   * original homebridge plugin never calls this for multi-setpoint heat/cool
   * zones (it always uses setOn() instead), and on at least some hardware
   * the heat/cool command is silently rejected. Callers must check
   * `mode === 'evap'` before calling this; see drivers/zone/device.ts.
   */
  async setUserEnabled(value: boolean, zone: RinnaiZone): Promise<void> {
    await this.service.setUserEnabled(value, zone);
  }

  async setFanState(value: boolean): Promise<void> {
    await this.service.setFanState(value);
  }

  async setFanSpeed(value: number): Promise<void> {
    await this.service.setFanSpeed(value);
  }

  async setPumpState(value: boolean): Promise<void> {
    await this.service.setPumpState(value);
  }
}
