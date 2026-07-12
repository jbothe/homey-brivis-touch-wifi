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
  connectionTimeout?: number;
  closeConnectionDelay?: number;
  debug?: boolean;
}

const MODE_TO_STRING: Record<number, RinnaiMode> = { 0: 'heat', 1: 'cool', 2: 'evap' };
const STRING_TO_MODE: Record<RinnaiMode, number> = { heat: 0, cool: 1, evap: 2 };

export type RinnaiControlMode = 'manual' | 'schedule';
const CONTROL_MODE_TO_STRING: Record<number, RinnaiControlMode> = { 0: 'manual', 1: 'schedule' };

export type RinnaiScheduleOverride = 'none' | 'advance' | 'operation';
const SCHEDULE_OVERRIDE_TO_STRING: Record<number, RinnaiScheduleOverride> = { 0: 'none', 1: 'advance', 2: 'operation' };

/**
 * Thin typed wrapper around the vendored RinnaiTouchRepository/RinnaiTouchService
 * (adapted from homebridge-rinnai-touch-plugin, see NOTICE.md). This is the only
 * class the rest of the app talks to - drivers/devices never touch the vendored
 * files directly.
 */
export class RinnaiConnection {
  private readonly service: any;

  private readonly repository: any;

  private initPromise: Promise<void> | null = null;

  constructor(logFn: (...args: any[]) => void, options: RinnaiConnectionOptions = {}) {
    const log = new Logger(logFn, options.debug ?? false);
    const settings = {
      address: options.address,
      port: options.port,
      connectionTimeout: options.connectionTimeout ?? 5000,
      closeConnectionDelay: options.closeConnectionDelay ?? 1100,
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
   * 'updated' if anything actually changed; errors are handled internally
   * (a failed poll is logged, not thrown).
   */
  async refresh(): Promise<void> {
    await this.service.updateStates();
  }

  async close(): Promise<void> {
    await this.repository.closeConnection();
  }

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
   * The system-wide on/off state (protocol path `{mode}.OOP.ST`). This is
   * distinct from getSystemActive()/getAutoEnabled(), which report whether
   * the unit is *currently* actively heating/cooling rather than whether
   * the user has switched it on. For multi-setpoint installations this is
   * the only real on/off control - see setUserEnabled() below.
   */
  get isOn(): boolean {
    return this.service.getState();
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

  async setTargetTemperature(value: number, zone: RinnaiZone = 'U'): Promise<void> {
    await this.service.setTargetTemperature(value, zone);
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
