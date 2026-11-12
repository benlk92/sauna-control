// Harvia cloud client (REST subset documented at harvia.io/api, v0.5.0) plus a simulated controller.

import type { Env } from './types';

export interface DeviceReading {
  connected: boolean;
  tempF: number | null;
  humidity: number | null;
  heaterOn: boolean | null; // null = couldn't tell from the shadow
  targetF: number | null;
  /** The controller's own on-time limit (settings.maxOnTime), minutes. */
  controllerMaxOnMin?: number | null;
  /** Duration of the controller's active profile, minutes. */
  profileDurationMin?: number | null;
  /** Minutes until the controller's own auto-off (counts down from heater start, preheat included). */
  autoOffMin?: number | null;
  /** The controller's own time-to-target estimate, minutes. */
  controllerEtaMin?: number | null;
  /** The element is energized right now (it cycles on and off to hold temperature). */
  elementOn?: boolean | null;
  raw?: unknown;
}

export interface Controller {
  read(): Promise<DeviceReading>;
  setTarget(f: number): Promise<void>;
  heater(on: boolean): Promise<void>;
  /** Set the controller's own session length (time at temperature), minutes. */
  setDuration(minutes: number): Promise<void>;
}

/** Login was rejected: alert the owner. */
export class HarviaAuthError extends Error {}
/** A command was rejected or timed out. */
export class HarviaCommandError extends Error {}

export const MAX_F = 194;
export const MIN_F = 104; // 40°C, the usual Fenix lower bound
/**
 * The session length the app asks the controller for at start: 60 min, the most the FX45 gives in one
 * go. With the controller's max on-time set to 3 h (in the Harvia app), this should cover preheat plus
 * an hour at temperature. The app ends the session itself at the chosen time.
 */
export const CONTROLLER_MAX_MIN = 60;

const cToF = (c: number) => (c * 9) / 5 + 32;
const fToC = (f: number) => ((f - 32) * 5) / 9;

/** Tiny key-value store the client uses to cache tokens (DO storage). */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

interface Tokens {
  idToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface Endpoints {
  generics: string;
  device: string;
  data: string;
  fetchedAt: number;
}

const COMMAND_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 15_000;

export class HarviaClient implements Controller {
  constructor(
    private env: Env,
    private kv: KV,
  ) {}

  private get toF() {
    return this.env.HARVIA_UNITS === 'F' ? (x: number) => x : cToF;
  }
  private get fromF() {
    return this.env.HARVIA_UNITS === 'F' ? (x: number) => x : fToC;
  }
  private get cabin() {
    return this.env.HARVIA_CABIN || 'C1';
  }

  private async endpoints(): Promise<Endpoints> {
    const cached = await this.kv.get<Endpoints>('harvia:endpoints');
    if (cached && Date.now() - cached.fetchedAt < 24 * 3600_000) return cached;
    const res = await fetch('https://api.harvia.io/endpoints');
    if (!res.ok) throw new Error(`Harvia endpoints ${res.status}`);
    const { endpoints } = (await res.json()) as any;
    const ep: Endpoints = {
      generics: endpoints.RestApi.generics.https,
      device: endpoints.RestApi.device.https,
      data: endpoints.RestApi.data.https,
      fetchedAt: Date.now(),
    };
    await this.kv.put('harvia:endpoints', ep);
    return ep;
  }

  private async login(): Promise<Tokens> {
    const ep = await this.endpoints();
    const res = await fetch(`${ep.generics}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.env.HARVIA_USERNAME, password: this.env.HARVIA_PASSWORD }),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new HarviaAuthError(`Harvia rejected the stored login (${res.status})`);
    }
    if (!res.ok) throw new Error(`Harvia login ${res.status}`);
    const t = (await res.json()) as any;
    const tokens = { idToken: t.idToken, refreshToken: t.refreshToken, expiresAt: Date.now() + (t.expiresIn ?? 3600) * 1000 };
    await this.kv.put('harvia:tokens', tokens);
    return tokens;
  }

  private async refresh(old: Tokens): Promise<Tokens> {
    const ep = await this.endpoints();
    const res = await fetch(`${ep.generics}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: old.refreshToken, email: this.env.HARVIA_USERNAME }),
    });
    if (!res.ok) return this.login();
    const t = (await res.json()) as any;
    const tokens = { idToken: t.idToken, refreshToken: old.refreshToken, expiresAt: Date.now() + (t.expiresIn ?? 3600) * 1000 };
    await this.kv.put('harvia:tokens', tokens);
    return tokens;
  }

  private async idToken(force = false): Promise<string> {
    const t = await this.kv.get<Tokens>('harvia:tokens');
    if (!t || force) return (await this.login()).idToken;
    if (t.expiresAt - Date.now() < 5 * 60_000) return (await this.refresh(t)).idToken;
    return t.idToken;
  }

  private async call(service: 'device' | 'data', method: string, path: string, body?: unknown, timeoutMs = READ_TIMEOUT_MS) {
    const ep = await this.endpoints();
    const doFetch = async (token: string) =>
      fetch(`${ep[service]}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    let res = await doFetch(await this.idToken());
    if (res.status === 401) res = await doFetch(await this.idToken(true));
    return res;
  }

  async deviceId(): Promise<string> {
    if (this.env.HARVIA_DEVICE_ID) return this.env.HARVIA_DEVICE_ID;
    const cached = await this.kv.get<string>('harvia:deviceId');
    if (cached) return cached;
    const body = await this.rawDevices();
    const list = body?.devices ?? body?.items ?? (Array.isArray(body) ? body : []);
    if (!list.length) throw new Error(`No devices found in Harvia's response: ${JSON.stringify(body).slice(0, 300)}`);
    const d = list[0];
    const id = d.deviceId ?? d.id ?? d.thingName ?? d.name;
    if (typeof id !== 'string' || !id) throw new Error(`Couldn't find a device id in: ${JSON.stringify(d).slice(0, 300)}`);
    await this.kv.put('harvia:deviceId', id);
    return id;
  }

  private async rawDevices(): Promise<any> {
    const res = await this.call('device', 'GET', '/devices?maxResults=10');
    if (!res.ok) throw new Error(`Harvia devices ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  async read(): Promise<DeviceReading> {
    const id = encodeURIComponent(await this.deviceId());
    const [stateRes, latestRes] = await Promise.all([
      this.call('device', 'GET', `/devices/state?deviceId=${id}&subId=${this.cabin}`),
      this.call('data', 'GET', `/data/latest-data?deviceId=${id}&cabinId=${this.cabin}`),
    ]);
    if (!stateRes.ok) throw new Error(`Harvia state ${stateRes.status}`);
    const state = (await stateRes.json()) as any;
    const latest = latestRes.ok ? ((await latestRes.json()) as any) : null;
    return parseReading(state, latest, this.toF);
  }

  /** Raw shadow + latest data, for mapping unknown field names. */
  async rawState(): Promise<unknown> {
    let devices: unknown;
    try {
      devices = await this.rawDevices();
    } catch (e) {
      return { step: 'list devices', error: (e as Error).message };
    }
    let deviceId: string;
    try {
      deviceId = await this.deviceId();
    } catch (e) {
      return { step: 'pick device', error: (e as Error).message, devices };
    }
    const id = encodeURIComponent(deviceId);
    const [s, l] = await Promise.all([
      this.call('device', 'GET', `/devices/state?deviceId=${id}&subId=${this.cabin}`),
      this.call('data', 'GET', `/data/latest-data?deviceId=${id}&cabinId=${this.cabin}`),
    ]);
    return {
      deviceId,
      devices,
      state: await s.json().catch(() => s.status),
      latest: await l.json().catch(() => l.status),
    };
  }

  async setTarget(f: number): Promise<void> {
    const target = Math.min(MAX_F, f);
    const res = await this.call(
      'device',
      'PATCH',
      '/devices/target',
      { deviceId: await this.deviceId(), cabin: { id: this.cabin }, temperature: Math.round(this.fromF(target)) },
      COMMAND_TIMEOUT_MS,
    ).catch((e) => {
      throw new HarviaCommandError(`Set target failed: ${e.message}`);
    });
    if (!res.ok) throw new HarviaCommandError(`Set target rejected (${res.status}): ${await res.text()}`);
  }

  /** ADJUST_DURATION (harvia.io/api, Device Service → Commands): "Adjusts the active session duration. Requires minutes." */
  async setDuration(minutes: number): Promise<void> {
    const res = await this.call(
      'device',
      'POST',
      '/devices/command',
      {
        deviceId: await this.deviceId(),
        cabin: { id: this.cabin },
        command: { type: 'ADJUST_DURATION', params: { minutes: Math.round(Math.min(CONTROLLER_MAX_MIN, minutes)) } },
      },
      COMMAND_TIMEOUT_MS,
    ).catch((e) => {
      throw new HarviaCommandError(`Set duration timed out: ${e.message}`);
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || body.handled === false) {
      throw new HarviaCommandError(`Set duration rejected: ${body.failureReason ?? body.message ?? res.status}`);
    }
  }

  async heater(on: boolean): Promise<void> {
    const res = await this.call(
      'device',
      'POST',
      '/devices/command',
      { deviceId: await this.deviceId(), cabin: { id: this.cabin }, command: { type: 'SAUNA', state: on ? 'on' : 'off' } },
      COMMAND_TIMEOUT_MS,
    ).catch((e) => {
      throw new HarviaCommandError(`${on ? 'Start' : 'Stop'} timed out: ${e.message}`);
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || body.handled === false) {
      throw new HarviaCommandError(`${on ? 'Start' : 'Stop'} rejected: ${body.failureReason ?? res.status}`);
    }
  }
}

/**
 * Field names as observed on a real Fenix (FX45, firmware 1.2.x), Nov 2026:
 *   shadow  state.heater.on (0/1)  — the session switch, stays 1 while the element cycles
 *           state.targetTemp (°C), state.settings.maxOnTime (min), state.profiles[activeProfile].duration
 *   latest  data.temp (°C), data.hum (0 = no sensor), data.heatOn (element energized right now),
 *           data.autoOffTime (min left; counts down from heater start, preheat included),
 *           data.timeToTarget (the controller's own preheat estimate, min)
 * Older/alternate names are kept as fallbacks.
 */
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const truthy = (x: unknown) => x === true || x === 1 || x === 'on' || x === 'true';

export function parseReading(state: any, latest: any, toF: (x: number) => number): DeviceReading {
  const s = state?.state ?? state?.reported ?? {};
  const d = latest?.data ?? {};

  const tempRaw = [d.temp, d.temperature, s.temp, s.temperature].find(isNum);
  const humRaw = [d.hum, d.humidity, s.hum].find(isNum);

  let heaterOn: boolean | null = null;
  if (s.heater && typeof s.heater === 'object' && s.heater.on !== undefined) heaterOn = truthy(s.heater.on);
  else if (s.saunaOn !== undefined) heaterOn = truthy(s.saunaOn);

  const target = [s.targetTemp, s.targetTemperature, d.targetTemp].find(isNum);
  const maxOn = s.settings?.maxOnTime;
  const profile = s.profiles?.[String(s.activeProfile)];

  return {
    connected: state?.connectionState?.connected ?? true,
    tempF: tempRaw !== undefined ? Math.round(toF(tempRaw) * 10) / 10 : null,
    // The FX45 reports 0 when it has no humidity sensor.
    humidity: humRaw !== undefined && humRaw > 0 ? humRaw : null,
    heaterOn,
    targetF: target !== undefined ? Math.round(toF(target)) : null,
    controllerMaxOnMin: isNum(maxOn) ? maxOn : null,
    profileDurationMin: isNum(profile?.duration) ? profile.duration : null,
    autoOffMin: isNum(d.autoOffTime) && heaterOn !== false ? d.autoOffTime : null,
    controllerEtaMin: isNum(d.timeToTarget) && d.timeToTarget > 0 ? d.timeToTarget : null,
    elementOn: d.heatOn !== undefined ? truthy(d.heatOn) : null,
    raw: { state, latest },
  };
}

/** A simulated controller for local testing. Heats ~2.5°F/min × MOCK_SPEED. */
export class MockController implements Controller {
  constructor(
    private env: Env,
    private kv: KV,
  ) {}

  private async sim() {
    const s = (await this.kv.get<any>('mock:sim')) ?? { tempF: 55, on: false, targetF: 194, t: Date.now(), offline: false };
    const speed = Number(this.env.MOCK_SPEED || 1);
    const mins = ((Date.now() - s.t) / 60_000) * speed;
    const ambient = 55;
    if (s.on) {
      // Heats quickly while far below target, holds just above it once there.
      if (s.tempF < s.targetF + 2) s.tempF = Math.min(s.targetF + 2, s.tempF + 2.5 * mins);
    } else {
      s.tempF = ambient + (s.tempF - ambient) * Math.exp(-mins / 90);
    }
    s.t = Date.now();
    await this.kv.put('mock:sim', s);
    return s;
  }

  async read(): Promise<DeviceReading> {
    const s = await this.sim();
    if (s.offline) throw new Error('Device unavailable (mock offline)');
    // The element cycles once it's near target: on below target, off above.
    const elementOn = s.on && s.tempF < s.targetF + 1;
    return { connected: true, tempF: Math.round(s.tempF * 10) / 10, humidity: 12, heaterOn: s.on, targetF: s.targetF, elementOn };
  }
  async setTarget(f: number) {
    const s = await this.sim();
    if (s.offline) throw new HarviaCommandError('Device unavailable');
    s.targetF = Math.min(MAX_F, f);
    await this.kv.put('mock:sim', s);
  }
  async setDuration(minutes: number) {
    const s = await this.sim();
    if (s.offline) throw new HarviaCommandError('Device unavailable');
    s.durationMin = Math.min(CONTROLLER_MAX_MIN, minutes);
    await this.kv.put('mock:sim', s);
  }
  async heater(on: boolean) {
    const s = await this.sim();
    if (s.offline) throw new HarviaCommandError('Device unavailable');
    s.on = on;
    await this.kv.put('mock:sim', s);
  }
}
