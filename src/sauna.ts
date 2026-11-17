// The single Durable Object that owns the sauna: sessions, schedules, polling, limits, alerts.

import { DurableObject } from 'cloudflare:workers';
import {
  HarviaAuthError,
  HarviaClient,
  MAX_F,
  MIN_F,
  MockController,
  type Controller,
  type DeviceReading,
  type KV,
} from './harvia';
import { CLEAN_START_MAX_F, etaMinutes, MAX_FIT_RUNS, predictPreheat, scheduledStart, type PreheatRun } from './model';
import { notify } from './notify';
import { maskPhone, normalizePhone } from './phone';
import { DEFAULT_SETTINGS, HEATER_KW, type Env, type Settings } from './types';

export type Mode = 'off' | 'heating' | 'hot' | 'bakeout';

interface Live {
  mode: Mode;
  sessionId: number | null;
  startedAt: number | null;
  startTempF: number | null;
  targetF: number | null;
  reachedAt: number | null;
  predictedMin: number | null;
  scheduleId: number | null;
  bakeoutAfter: boolean;
  bakeoutStartedAt: number | null;
  bakeoutEndsAt: number | null;
  lastReading: { t: number; f: number; humidity: number | null; heatOn?: boolean | null } | null;
  offlineSince: number | null;
  offStreak: number;
  slowRiseChecked: boolean;
  stopPending: boolean;
  tellSentAt: number | null;
  lastSessionId: number | null;
  lastEndedAt: number | null;
  lastEndReason: string | null;
  alerts: { t: number; text: string }[];
  alertedKeys: Record<string, number>;
  controllerLimits: { maxOnMin: number | null; profileMin: number | null } | null;
  controllerOffAt: number | null;
  /** Id of the current "I'm coming" list. A new id = an empty list. */
  comersRound: number | null;
  /** A session ended and the room hasn't dropped below SESSION_OVER_BELOW_F yet. */
  cooldownPending: boolean;
  /** Time at temperature for this session, minutes (always AT_TEMP_MIN). The app ends it; the controller's 3 h max on-time is the backstop. */
  atTempMin: number | null;
  /** Element-energized time so far this session (or bake-out); null until the controller reports it. */
  elementMs: number | null;
  elementLast: { t: number; on: boolean } | null;
  /** Owner tapped "I'm leaving": the heater stays on until this to dry the room, then the app stops it. */
  leaveEndsAt: number | null;
}

const BLANK: Live = {
  mode: 'off',
  sessionId: null,
  startedAt: null,
  startTempF: null,
  targetF: null,
  reachedAt: null,
  predictedMin: null,
  scheduleId: null,
  bakeoutAfter: false,
  bakeoutStartedAt: null,
  bakeoutEndsAt: null,
  lastReading: null,
  offlineSince: null,
  offStreak: 0,
  slowRiseChecked: false,
  stopPending: false,
  tellSentAt: null,
  lastSessionId: null,
  lastEndedAt: null,
  lastEndReason: null,
  alerts: [],
  alertedKeys: {},
  controllerLimits: null,
  controllerOffAt: null,
  comersRound: null,
  cooldownPending: false,
  atTempMin: null,
  elementMs: null,
  elementLast: null,
  leaveEndsAt: null,
};

const ACTIVE_POLL_MS = 30_000;
/** While the sauna is off, the thermometer is read about this often (owner's call: keep Harvia calls low). */
const IDLE_POLL_MS = 30 * 60_000;
const LIVE_WINDOW_MS = 3600_000;
/** Round-the-clock readings are kept this long. */
const TEMPS_KEEP_MS = 2 * 86400_000;
const SCHEDULE_CHECK_MS = 15 * 60_000;
const OFFLINE_ALERT_MS = 5 * 60_000;
// The IKI Pillar's stone mass delays the air temperature rise (+1.8°F in the first ~4 min on
// the first real run), so allow 20 min before deciding the heater isn't working.
const SLOW_RISE_WINDOW_MS = 20 * 60_000;
const SLOW_RISE_MIN_F = 10;
const PREHEAT_CAP_MS = 150 * 60_000;
// A session is over (and the "I'm coming" list clears) once the room drops below this after the
// heater goes off. The stone stove holds heat for hours, so keep checking for up to 8 h.
const SESSION_OVER_BELOW_F = 130;
/** A gap longer than this between readings isn't counted as element-on time (controller offline). */
const ELEMENT_GAP_MAX_MS = 5 * 60_000;
const COOLING_MAX_MS = 8 * 3600_000;
/** Names left on the list with no session ever started drop off after this. */
const COMER_STALE_MS = 24 * 3600_000;
/**
 * The "I wanna sauna" queue lives as a whole: it clears only once the most recent request is
 * older than this. Anyone in it when the sauna starts moves to "I'm coming", however long they've waited.
 */
export const REQUEST_TTL_MS = 3600_000;

export class SaunaDO extends DurableObject<Env> {
  private kv: KV;
  private controller: Controller;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.kv = {
      get: (k) => ctx.storage.get(k),
      put: (k, v) => ctx.storage.put(k, v),
    };
    this.controller = env.HARVIA_MOCK === '1' ? new MockController(env, this.kv) : new HarviaClient(env, this.kv);
  }

  // ---------- state helpers ----------

  private async live(): Promise<Live> {
    return { ...BLANK, ...((await this.ctx.storage.get<Live>('live')) ?? {}) };
  }
  private async save(l: Live) {
    await this.ctx.storage.put('live', l);
  }

  async settings(): Promise<Settings> {
    const row = await this.env.DB.prepare("SELECT value FROM settings WHERE key = 'settings'").first<{ value: string }>();
    return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}) };
  }

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const s = { ...(await this.settings()) };
    const num = (v: unknown, lo: number, hi: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
    };
    s.bakeoutMin = num(patch.bakeoutMin, 5, 120) ?? s.bakeoutMin;
    s.bakeoutF = num(patch.bakeoutF, MIN_F, MAX_F) ?? s.bakeoutF;
    s.ratePerKwh = num(patch.ratePerKwh, 0, 5) ?? s.ratePerKwh;
    s.cookieDays = num(patch.cookieDays, 1, 365) ?? s.cookieDays;
    if (typeof patch.ownerName === 'string' && patch.ownerName.trim()) s.ownerName = patch.ownerName.trim().slice(0, 30);
    if (Array.isArray(patch.reminders)) {
      s.reminders = patch.reminders.map((r) => String(r).trim().slice(0, 200)).filter(Boolean).slice(0, 12);
    }
    if (typeof patch.timeZone === 'string') {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: patch.timeZone });
        s.timeZone = patch.timeZone;
      } catch {
        /* not a real time zone; keep the old one */
      }
    }
    await this.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('settings', ?)").bind(JSON.stringify(s)).run();
    return s;
  }

  private async cleanRuns(): Promise<PreheatRun[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT start_temp_f AS startF, target_f AS targetF, (reached_at - started_at) / 60000.0 AS minutes
       FROM sessions
       WHERE reached_at IS NOT NULL AND target_changed = 0 AND went_offline = 0
         AND start_temp_f IS NOT NULL AND start_temp_f <= ?
       ORDER BY started_at DESC LIMIT ?`,
    )
      .bind(CLEAN_START_MAX_F, MAX_FIT_RUNS)
      .all<PreheatRun>();
    return results;
  }

  /** Private alert to the owner. `key` de-duplicates within `throttleMs`. */
  private async alert(l: Live, text: string, key?: string, throttleMs = Infinity) {
    if (key) {
      const last = l.alertedKeys[key];
      if (last && Date.now() - last < throttleMs) return;
      l.alertedKeys[key] = Date.now();
    }
    l.alerts = [{ t: Date.now(), text }, ...l.alerts].slice(0, 10);
    await notify(this.env, 'owner', { title: 'Sauna alert', body: text, url: '/control', tag: key ?? 'alert' });
  }

  private async handleError(l: Live, e: unknown, context: string) {
    if (e instanceof HarviaAuthError) {
      await this.alert(l, 'Harvia rejected the stored login. Update HARVIA_PASSWORD.', 'auth', 6 * 3600_000);
    } else {
      await this.alert(l, `${context}: ${(e as Error).message}`);
    }
  }

  private async readDevice(l: Live): Promise<DeviceReading | null> {
    try {
      const r = await this.controller.read();
      if (!r.connected) throw new Error('controller reports offline');
      l.offlineSince = null;
      if (r.tempF !== null) {
        l.lastReading = { t: Date.now(), f: r.tempF, humidity: r.humidity, heatOn: r.elementOn ?? null };
        await this.recordTemp(l.lastReading.t, r.tempF, r.elementOn ?? null);
      }
      if (l.mode !== 'off' && r.elementOn != null) {
        this.countElement(l, Date.now());
        l.elementLast = { t: Date.now(), on: r.elementOn };
      }
      if (r.controllerMaxOnMin != null || r.profileDurationMin != null) {
        l.controllerLimits = { maxOnMin: r.controllerMaxOnMin ?? null, profileMin: r.profileDurationMin ?? null };
      }
      l.controllerOffAt = r.autoOffMin != null ? Date.now() + r.autoOffMin * 60_000 : null;
      if (r.controllerEtaMin != null && l.sessionId && l.mode === 'heating') {
        // Log the controller's first estimate next to ours, for comparison in the Log.
        await this.env.DB.prepare('UPDATE sessions SET fx_predicted_min = ? WHERE id = ? AND fx_predicted_min IS NULL')
          .bind(r.controllerEtaMin, l.sessionId)
          .run();
      }
      return r;
    } catch (e) {
      if (e instanceof HarviaAuthError) await this.handleError(l, e, 'Read');
      l.offlineSince ??= Date.now();
      return null;
    }
  }

  /** Every reading, on or off, for the live "past hour" graph. Old rows are trimmed now and then. */
  private async recordTemp(t: number, f: number, heatOn: boolean | null) {
    await this.env.DB.prepare('INSERT OR REPLACE INTO temps (t, temp_f, heat_on) VALUES (?, ?, ?)')
      .bind(t, f, heatOn == null ? null : heatOn ? 1 : 0)
      .run();
    if (t % 60 < 1) await this.env.DB.prepare('DELETE FROM temps WHERE t < ?').bind(t - TEMPS_KEEP_MS).run();
  }

  /** Add the time since the last reading if the element was on then. */
  private countElement(l: Live, now: number) {
    l.elementMs ??= 0;
    if (l.elementLast?.on) l.elementMs += Math.min(ELEMENT_GAP_MAX_MS, Math.max(0, now - l.elementLast.t));
  }

  /** Close out element time at the end of a session or bake-out; returns the total (null = never reported). */
  private takeElement(l: Live, now: number): number | null {
    if (l.elementLast) this.countElement(l, now);
    const ms = l.elementMs;
    l.elementMs = null;
    l.elementLast = null;
    return ms;
  }

  private freshTemp(l: Live, maxAgeMs = 30 * 60_000): number | null {
    return l.lastReading && Date.now() - l.lastReading.t < maxAgeMs ? l.lastReading.f : null;
  }

  // ---------- owner actions ----------

  async start(targetF: number, opts: { scheduleId?: number; bakeoutAfter?: boolean } = {}) {
    const l = await this.live();
    if (l.mode === 'heating' || l.mode === 'hot') return { ok: true, already: true };
    if (l.mode === 'bakeout') await this.finishBakeout(l);
    const target = Math.round(Math.min(MAX_F, Math.max(MIN_F, targetF)));
    const atTemp = AT_TEMP_MIN;
    try {
      await this.controller.setTarget(target);
      await this.controller.heater(true);
    } catch (e) {
      await this.handleError(l, e, opts.scheduleId ? 'Scheduled start failed' : 'Start failed');
      await this.save(l);
      throw e;
    }
    const now = Date.now();
    const reading = await this.readDevice(l);
    const startF = reading?.tempF ?? this.freshTemp(l);
    const pred = predictPreheat(await this.cleanRuns(), startF ?? 50, target);
    const res = await this.env.DB.prepare(
      'INSERT INTO sessions (started_at, start_temp_f, target_f, predicted_min, schedule_id, at_temp_min) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    )
      .bind(now, startF, target, pred.minutes, opts.scheduleId ?? null, atTemp)
      .first<{ id: number }>();
    Object.assign(l, {
      mode: 'heating',
      sessionId: res!.id,
      startedAt: now,
      startTempF: startF,
      targetF: target,
      reachedAt: null,
      predictedMin: pred.minutes,
      scheduleId: opts.scheduleId ?? null,
      bakeoutAfter: !!opts.bakeoutAfter,
      offStreak: 0,
      slowRiseChecked: false,
      stopPending: false,
      tellSentAt: null,
      alertedKeys: {},
      atTempMin: atTemp,
      elementMs: null,
      elementLast: null,
      leaveEndsAt: null,
    } satisfies Partial<Live>);
    if (startF !== null) await this.recordReading(l);
    await this.convertRequests(l, now);
    await this.save(l);
    // Already at temperature (a warm room): mark it hot now instead of waiting for the next poll.
    if (startF !== null && startF >= target) await this.alarm();
    else await this.scheduleAlarm(l);
    return { ok: true };
  }

  /** "I'm leaving": keep the heater on for the dry-out time, then turn it off. One session, one log row. */
  async leave(cancel = false) {
    const l = await this.live();
    if (l.mode !== 'heating' && l.mode !== 'hot') throw new Error('The sauna isn’t on');
    const now = Date.now();
    l.leaveEndsAt = cancel ? null : now + (await this.settings()).bakeoutMin * 60_000;
    if (l.sessionId) await this.env.DB.prepare('UPDATE sessions SET left_at = ? WHERE id = ?').bind(cancel ? null : now, l.sessionId).run();
    await this.save(l);
    return { ok: true };
  }

  async clearAlerts() {
    const l = await this.live();
    l.alerts = [];
    await this.save(l);
    return { ok: true };
  }


  async changeTarget(targetF: number) {
    const l = await this.live();
    const target = Math.round(Math.min(MAX_F, Math.max(MIN_F, targetF)));
    await this.controller.setTarget(target);
    if (l.sessionId && (l.mode === 'heating' || l.mode === 'hot')) {
      if (l.mode === 'heating') {
        await this.env.DB.prepare('UPDATE sessions SET target_changed = 1, target_f = ? WHERE id = ?').bind(target, l.sessionId).run();
      }
      l.targetF = target;
      if (l.mode === 'hot' && l.lastReading && l.lastReading.f < target) l.mode = 'heating';
      await this.save(l);
    }
    return { ok: true };
  }

  async stop(reason = 'manual') {
    const l = await this.live();
    try {
      await this.controller.heater(false);
      l.stopPending = false;
    } catch (e) {
      // Keep retrying every tick; the controller's own timer is the backstop.
      l.stopPending = true;
      await this.handleError(l, e, 'Stop failed (retrying)');
    }
    if (l.mode === 'bakeout') await this.finishBakeout(l);
    else if (l.mode !== 'off') await this.endSession(l, reason);
    await this.save(l);
    await this.scheduleAlarm(l);
    if (l.stopPending) throw new Error('Stop command failed; retrying every 30 s');
    return { ok: true };
  }

  private async endSession(l: Live, reason: string) {
    const now = Date.now();
    if (l.sessionId) {
      await this.env.DB.prepare(
        `UPDATE sessions SET ended_at = ?, end_reason = ?, heater_on_ms = ?, element_on_ms = ?,
           stopped_manually_preheat = CASE WHEN reached_at IS NULL AND ? = 'manual' THEN 1 ELSE 0 END
         WHERE id = ?`,
      )
        .bind(now, reason, now - (l.startedAt ?? now), this.takeElement(l, now), reason, l.sessionId)
        .run();
    }
    const bakeoutAfter = l.bakeoutAfter && reason === 'max_time';
    Object.assign(l, {
      mode: 'off',
      lastSessionId: l.sessionId,
      lastEndedAt: now,
      lastEndReason: reason,
      cooldownPending: true,
      sessionId: null,
      reachedAt: null,
      tellSentAt: null,
      bakeoutAfter: false,
      leaveEndsAt: null,
    } satisfies Partial<Live>);
    if (bakeoutAfter) {
      try {
        await this.beginBakeout(l);
      } catch (e) {
        await this.handleError(l, e, 'Bake-out start failed');
      }
    }
  }

  async startBakeout() {
    const l = await this.live();
    if (l.mode !== 'off') throw new Error('Stop the session first');
    try {
      await this.beginBakeout(l);
    } catch (e) {
      await this.handleError(l, e, 'Bake-out start failed');
      await this.save(l);
      throw e;
    }
    await this.save(l);
    await this.scheduleAlarm(l);
    return { ok: true };
  }

  private async beginBakeout(l: Live) {
    const s = await this.settings();
    await this.controller.setTarget(s.bakeoutF);
    await this.controller.heater(true);
    l.mode = 'bakeout';
    l.elementMs = null;
    l.elementLast = null;
    l.bakeoutStartedAt = Date.now();
    l.bakeoutEndsAt = Date.now() + s.bakeoutMin * 60_000;
    l.offStreak = 0;
  }

  private async finishBakeout(l: Live) {
    const element = this.takeElement(l, Date.now());
    if (l.lastSessionId && l.bakeoutStartedAt) {
      await this.env.DB.prepare(
        `UPDATE sessions SET bakeout_ms = bakeout_ms + ?,
           element_on_ms = CASE WHEN ? IS NULL THEN element_on_ms ELSE COALESCE(element_on_ms, 0) + ? END
         WHERE id = ?`,
      )
        .bind(Date.now() - l.bakeoutStartedAt, element, element, l.lastSessionId)
        .run();
    }
    l.mode = 'off';
    l.bakeoutStartedAt = null;
    l.bakeoutEndsAt = null;
    l.lastEndedAt = Date.now();
  }

  async schedule(hotBy: number, targetF: number, bakeoutAfter: boolean) {
    if (!(hotBy > Date.now())) throw new Error('Pick a time in the future');
    const target = Math.round(Math.min(MAX_F, Math.max(MIN_F, targetF)));
    await this.env.DB.prepare('INSERT INTO schedules (hot_by, target_f, bakeout_after, created_at) VALUES (?, ?, ?, ?)')
      .bind(hotBy, target, bakeoutAfter ? 1 : 0, Date.now())
      .run();
    const l = await this.live();
    await this.planSchedules(l, false);
    await this.save(l);
    await this.scheduleAlarm(l);
    return { ok: true };
  }

  async previewSchedule(hotBy: number, targetF: number) {
    const l = await this.live();
    const target = Math.round(Math.min(MAX_F, Math.max(MIN_F, targetF)));
    const startF = this.freshTemp(l) ?? 50;
    const pred = predictPreheat(await this.cleanRuns(), startF, target);
    return { predictedMin: pred.minutes, method: pred.method, runs: pred.runs, startAt: Math.round(scheduledStart(hotBy, pred.minutes)), assumedStartF: startF };
  }

  async cancelSchedule(id: number) {
    await this.env.DB.prepare("UPDATE schedules SET status = 'cancelled' WHERE id = ? AND status = 'pending'").bind(id).run();
    await this.scheduleAlarm(await this.live());
    return { ok: true };
  }

  async tellFriends() {
    const l = await this.live();
    const f = l.lastReading?.f;
    const sent = await notify(this.env, 'friend', {
      title: "Sauna's hot",
      body: f ? `It's ${Math.round(f)}°F. Tap if you're coming.` : "Tap if you're coming.",
      url: '/',
      tag: 'hot',
    });
    l.tellSentAt = Date.now();
    await this.save(l);
    return { ok: true, sent };
  }

  /**
   * The friend's button on Status. While the sauna is on it means "I'm coming"; otherwise it's a
   * "I wanna sauna" request that turns into "I'm coming" if the owner starts it within an hour.
   */
  async coming(clientId: string, name: string, phone?: string | null, forAtRaw?: number | null) {
    const l = await this.live();
    const clean = name.trim().slice(0, 40);
    if (!clean) throw new Error('Name required');
    clientId = clientId.slice(0, 64);
    const now = Date.now();
    // An optional "when": null or a time in the past means now; no more than a day ahead.
    const forAt = forAtRaw != null && Number.isFinite(forAtRaw) && forAtRaw > now + 60_000 ? Math.min(forAtRaw, now + 24 * 3600_000) : null;
    if (l.mode !== 'heating' && l.mode !== 'hot') return this.request(clientId, clean, phone, forAt);
    const round = await this.round(l);
    const existing = await this.env.DB.prepare('SELECT 1 FROM comers WHERE session_id = ? AND client_id = ? AND at > ?')
      .bind(round, clientId, Date.now() - COMER_STALE_MS)
      .first();
    await this.env.DB.prepare(
      `INSERT INTO comers (session_id, client_id, name, at, for_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (session_id, client_id) DO UPDATE SET name = excluded.name, at = excluded.at, for_at = excluded.for_at`,
    )
      .bind(round, clientId, clean, now, forAt)
      .run();
    if (!existing) {
      const when = forAt ? ` at ${await this.ownerTime(forAt)}` : '';
      await notify(this.env, 'owner', { title: `${clean} is coming${when}`, body: '', url: '/control', tag: `coming-${clientId}`, silent: true });
    }
    return { ok: true, kind: 'coming' as const };
  }

  /** "7:30 PM" in the owner's time zone, for push notifications. */
  private async ownerTime(ms: number) {
    const tz = (await this.settings()).timeZone;
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  }

  private async request(clientId: string, name: string, phone?: string | null, forAt: number | null = null) {
    const now = Date.now();
    await this.pruneQueue(now);
    const existing = await this.env.DB.prepare('SELECT phone FROM requests WHERE client_id = ?')
      .bind(clientId)
      .first<{ phone: string | null }>();
    const keepPhone = phone === undefined ? (existing?.phone ?? null) : phone === null ? null : this.checkPhone(phone);
    // Asking again refreshes the time, which restarts that person's hour.
    await this.env.DB.prepare('INSERT OR REPLACE INTO requests (client_id, name, at, phone, for_at) VALUES (?, ?, ?, ?, ?)')
      .bind(clientId, name, now, keepPhone, forAt)
      .run();
    if (!existing) {
      const when = forAt ? ` at ${await this.ownerTime(forAt)}` : '';
      await notify(this.env, 'owner', { title: `${name} wants a sauna${when}`, body: 'Start it and they move to “I’m coming”.', url: '/control', tag: `request-${clientId}` });
    }
    return { ok: true, kind: 'request' as const };
  }

  private checkPhone(raw: string): string {
    const p = normalizePhone(raw);
    if (!p) throw new Error('That doesn’t look like a phone number');
    return p;
  }

  /** Add or remove the optional "text me" number on this person's request (or I'm-coming entry). */
  async setPhone(clientId: string, raw: string | null) {
    const l = await this.live();
    const phone = raw === null || raw.trim() === '' ? null : this.checkPhone(raw);
    clientId = clientId.slice(0, 64);
    const round = await this.round(l);
    const r1 = await this.env.DB.prepare('UPDATE requests SET phone = ? WHERE client_id = ?').bind(phone, clientId).run();
    const r2 = await this.env.DB.prepare('UPDATE comers SET phone = ? WHERE session_id = ? AND client_id = ?').bind(phone, round, clientId).run();
    if (!r1.meta.changes && !r2.meta.changes) throw new Error('Tap “I wanna sauna” first');
    return { ok: true, phone: phone ? maskPhone(phone) : null };
  }

  /** People on the current list who left a number, for the owner's "text them" button. */
  private async textList(l: Live) {
    const round = await this.round(l);
    return (
      await this.env.DB.prepare('SELECT name, phone FROM comers WHERE session_id = ? AND phone IS NOT NULL ORDER BY at')
        .bind(round)
        .all<{ name: string; phone: string }>()
    ).results;
  }

  /**
   * Clear the whole queue once its newest request is over an hour old. Never one at a time.
   * A request for a later time counts from that time ("8 pm" stays until 9 pm).
   */
  private async pruneQueue(now: number) {
    await this.env.DB.prepare('DELETE FROM requests WHERE (SELECT MAX(MAX(at, COALESCE(for_at, 0))) FROM requests) <= ?')
      .bind(now - REQUEST_TTL_MS)
      .run();
  }

  /** On start: everyone still in the queue is now coming; the queue empties. */
  private async convertRequests(l: Live, now: number) {
    const round = await this.round(l);
    await this.pruneQueue(now);
    await this.env.DB.batch([
      this.env.DB.prepare(
        'INSERT OR REPLACE INTO comers (session_id, client_id, name, at, phone, for_at) SELECT ?, client_id, name, ?, phone, for_at FROM requests',
      ).bind(round, now),
      this.env.DB.prepare('DELETE FROM requests'),
    ]);
  }

  /** The current list id (the comers table's session_id column holds it). */
  private async round(l: Live): Promise<number> {
    if (l.comersRound == null) {
      l.comersRound = Date.now();
      await this.save(l);
    }
    return l.comersRound;
  }

  /** After a session, clear the "I'm coming" list once the room has cooled below SESSION_OVER_BELOW_F. */
  private async maybeFinishCooldown(l: Live) {
    if (l.mode !== 'off' || !l.cooldownPending || !l.lastReading) return;
    if (l.lastReading.t > (l.lastEndedAt ?? 0) && l.lastReading.f < SESSION_OVER_BELOW_F) {
      l.cooldownPending = false;
      l.comersRound = Date.now();
      // The finished session's list (and any phone numbers on it) is no longer needed.
      await this.env.DB.prepare('DELETE FROM comers WHERE session_id != ?').bind(l.comersRound).run();
    }
  }

  private cooldownWatch(l: Live, now = Date.now()) {
    return l.mode === 'off' && l.cooldownPending && !!l.lastEndedAt && now - l.lastEndedAt < COOLING_MAX_MS;
  }

  async debugRaw() {
    if (this.controller instanceof HarviaClient) return this.controller.rawState();
    return { mock: await this.ctx.storage.get('mock:sim') };
  }

  /** Mock only: simulate the controller dropping offline. */
  async mockOffline(offline: boolean) {
    if (this.env.HARVIA_MOCK !== '1') throw new Error('not in mock mode');
    const s = (await this.ctx.storage.get<any>('mock:sim')) ?? {};
    await this.ctx.storage.put('mock:sim', { ...s, offline });
    return { ok: true };
  }

  // ---------- status ----------

  async status(owner: boolean, clientId?: string) {
    let l = await this.live();
    // While off, a page view refreshes a reading only if the last one is older than the idle interval.
    if (l.mode === 'off' && (!l.lastReading || Date.now() - l.lastReading.t > IDLE_POLL_MS)) {
      const lastTry = (await this.ctx.storage.get<number>('idleReadAt')) ?? 0;
      if (Date.now() - lastTry > IDLE_POLL_MS) {
        await this.ctx.storage.put('idleReadAt', Date.now());
        await this.readDevice(l);
        await this.maybeFinishCooldown(l);
        await this.save(l);
        l = await this.live();
      }
    }
    const s = await this.settings();
    const now = Date.now();
    const runs = await this.cleanRuns();
    const state = l.mode === 'off' ? (l.cooldownPending ? 'cooling' : 'off') : l.mode;

    let etaMin: number | null = null;
    if (l.mode === 'heating' && l.targetF) {
      const cur = l.lastReading?.f ?? l.startTempF ?? 50;
      etaMin = etaMinutes(runs, l.startTempF ?? cur, cur, l.targetF);
    }

    // The graph is always live: the past hour of readings, whether or not the sauna is on.
    const readings = (
      await this.env.DB.prepare('SELECT t, temp_f AS f FROM temps WHERE t > ? ORDER BY t').bind(now - LIVE_WINDOW_MS).all<{
        t: number;
        f: number;
      }>()
    ).results;
    // Polling runs on the alarm; make sure one is set (e.g. right after a deploy).
    if ((await this.ctx.storage.getAlarm()) == null) await this.scheduleAlarm(l);
    // The list spans before, during and after a session; with no session running or cooling,
    // names older than a day drop off so a sauna that never got lit doesn't keep stale names.
    await this.pruneQueue(now);
    const requests = (
      await this.env.DB.prepare('SELECT client_id, name, at, phone, for_at FROM requests ORDER BY at').all<{
        client_id: string;
        name: string;
        at: number;
        phone: string | null;
        for_at: number | null;
      }>()
    ).results;
    const queueClearsAt = requests.length ? Math.max(...requests.map((r) => Math.max(r.at, r.for_at ?? 0))) + REQUEST_TTL_MS : null;
    const comersRound = await this.round(l);
    const idle = l.mode === 'off' && !l.cooldownPending;
    const comers = (
      await this.env.DB.prepare('SELECT client_id, name, at, phone, for_at FROM comers WHERE session_id = ? AND at > ? ORDER BY COALESCE(for_at, at)')
        .bind(comersRound, idle ? now - COMER_STALE_MS : 0)
        .all<{ client_id: string; name: string; at: number; phone: string | null; for_at: number | null }>()
    ).results;

    const pub = {
      ownerName: s.ownerName,
      state,
      currentF: l.lastReading?.f ?? null,
      readingAt: l.lastReading?.t ?? null,
      targetF: l.mode === 'off' ? null : l.targetF,
      etaMin,
      startedAt: l.mode === 'off' ? null : l.startedAt,
      reachedAt: l.reachedAt,
      readings,
      graph: { from: now - LIVE_WINDOW_MS, targetF: l.mode === 'heating' || l.mode === 'hot' ? l.targetF : null },
      comers: comers.map((c) => c.name),
      comerList: comers.map((c) => ({ name: c.name, forAt: c.for_at })),
      reminders: s.reminders,
      // Owner tapped "I'm leaving": friends see it's wrapping up.
      wrappingUpAt: l.mode === 'heating' || l.mode === 'hot' ? l.leaveEndsAt : null,
      comersRound,
      youreComing: !!clientId && comers.some((c) => c.client_id === clientId),
      requests: requests.map((r) => ({ name: r.name, at: r.at, forAt: r.for_at })),
      queueClearsAt,
      youAskedAt: requests.find((r) => r.client_id === clientId)?.at ?? null,
      // Only this person's own number, masked. Nobody else's number is ever in the public status.
      yourPhone: (() => {
        const mine = requests.find((r) => r.client_id === clientId) ?? comers.find((c) => c.client_id === clientId);
        return clientId && mine?.phone ? maskPhone(mine.phone) : null;
      })(),
      offline: !!l.offlineSince,
    };
    if (!owner) return pub;

    const endsAt =
      l.mode !== 'heating' && l.mode !== 'hot' ? null
      : l.leaveEndsAt ? l.leaveEndsAt
      : l.mode === 'hot' && l.reachedAt ? l.reachedAt + (l.atTempMin ?? AT_TEMP_MIN) * 60_000
      : null;

    const schedules = (
      await this.env.DB.prepare("SELECT * FROM schedules WHERE status = 'pending' ORDER BY hot_by").all<any>()
    ).results;
    return {
      ...pub,
      humidity: l.lastReading?.humidity ?? null,
      textList: await this.textList(l),
      // Owner-only: people waiting on an "I wanna sauna" who left a number, for texting before it's on.
      requestTextList: requests.filter((r) => r.phone).map((r) => ({ name: r.name, phone: r.phone as string })),
      comersWithoutPhone: comers.filter((c) => !c.phone).map((c) => c.name),
      atTempMin: l.mode === 'heating' || l.mode === 'hot' ? (l.atTempMin ?? AT_TEMP_MIN) : null,
      endsAt,
      timeLeftMin: endsAt ? Math.max(0, Math.round((endsAt - now) / 60_000)) : null,
      leaving: !!l.leaveEndsAt && (l.mode === 'heating' || l.mode === 'hot'),
      bakeoutLeftMin: l.mode === 'bakeout' && l.bakeoutEndsAt ? Math.max(0, Math.round((l.bakeoutEndsAt - now) / 60_000)) : null,
      predictedMin: l.predictedMin,
      tellSentAt: l.tellSentAt,
      canBakeout: l.mode === 'off' && !!l.lastEndedAt && now - l.lastEndedAt < 2 * 3600_000,
      stopPending: l.stopPending,
      alerts: l.alerts,
      schedules,
      settings: s,
      model: predictPreheat(runs, this.freshTemp(l) ?? 50, 194),
      mock: this.env.HARVIA_MOCK === '1',
      controllerLimits: l.controllerLimits,
      // The controller's own timer may end the session first; the app never extends it.
      controllerOffAt: (() => {
        if (l.mode === 'off') return null;
        // Prefer the controller's live countdown; fall back to max on-time from the start.
        if (l.controllerOffAt) return l.controllerOffAt;
        const since = l.mode === 'bakeout' ? l.bakeoutStartedAt : l.startedAt;
        const max = l.controllerLimits?.maxOnMin;
        return max && since ? since + max * 60_000 : null;
      })(),
    };
  }

  async log() {
    const s = await this.settings();
    const l = await this.live();
    const { results } = await this.env.DB.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1000').all<any>();
    return results.map((r) => {
      const heaterMs = (r.ended_at ? r.heater_on_ms : Date.now() - r.started_at) + (r.bakeout_ms ?? 0);
      // Cost from the time the element was actually energized; older sessions only have the
      // wall-clock time, which is an upper bound.
      const running = r.id === l.sessionId;
      const elementMs: number | null = running ? l.elementMs : r.element_on_ms;
      const kwh = (HEATER_KW * (elementMs ?? heaterMs)) / 3600_000;
      return {
        id: r.id,
        startedAt: r.started_at,
        startF: r.start_temp_f,
        targetF: r.target_f,
        predictedMin: r.predicted_min,
        fxPredictedMin: r.fx_predicted_min ?? null,
        actualMin: r.reached_at ? (r.reached_at - r.started_at) / 60_000 : null,
        atTempMin: r.reached_at && r.ended_at ? (r.ended_at - r.reached_at) / 60_000 : null,
        heaterOnMin: heaterMs / 60_000,
        elementOnMin: elementMs != null ? elementMs / 60_000 : null,
        atTempPlannedMin: r.at_temp_min ?? null,
        dryOutMin: r.left_at && r.ended_at ? (r.ended_at - r.left_at) / 60_000 : null,
        bakeoutMin: (r.bakeout_ms ?? 0) / 60_000,
        kwh,
        cost: kwh * s.ratePerKwh,
        endReason: r.end_reason,
        clean: !!r.reached_at && !r.target_changed && !r.went_offline && r.start_temp_f !== null && r.start_temp_f <= CLEAN_START_MAX_F,
      };
    });
  }

  // ---------- the tick ----------

  private async recordReading(l: Live, sessionId = l.sessionId) {
    if (!sessionId || !l.lastReading) return;
    const h = l.lastReading.heatOn;
    await this.env.DB.prepare('INSERT INTO readings (session_id, t, temp_f, humidity, heat_on) VALUES (?, ?, ?, ?, ?)')
      .bind(sessionId, l.lastReading.t, l.lastReading.f, l.lastReading.humidity, h == null ? null : h ? 1 : 0)
      .run();
  }

  async alarm() {
    const l = await this.live();
    try {
      await this.tick(l);
    } catch (e) {
      console.error('tick failed', e);
    }
    await this.save(l);
    await this.scheduleAlarm(l);
  }

  /** Lets the owner UI nudge a refresh (e.g. right after Start). */
  async poke() {
    await this.alarm();
    return { ok: true };
  }

  private async tick(l: Live) {
    const now = Date.now();
    const s = await this.settings();

    if (l.stopPending) {
      try {
        await this.controller.heater(false);
        l.stopPending = false;
      } catch {
        /* keep retrying */
      }
    }

    if (l.mode === 'off') {
      // Cooling: keep reading until the room drops below 100°F, which ends the session for friends.
      // Off: still read every minute for the live graph; after a session this also watches the cool-down.
      const cooling = this.cooldownWatch(l, now);
      if (await this.readDevice(l)) {
        if (cooling) await this.recordReading(l, l.lastSessionId); // keep the cool-down in the session's history
      }
      if (cooling) await this.maybeFinishCooldown(l);
      await this.planSchedules(l, true);
      return;
    }

    const r = await this.readDevice(l);

    if (!r) {
      if (l.mode === 'heating' && l.sessionId) {
        await this.env.DB.prepare('UPDATE sessions SET went_offline = 1 WHERE id = ?').bind(l.sessionId).run();
      }
      if (l.offlineSince && now - l.offlineSince > OFFLINE_ALERT_MS) {
        await this.alert(l, "Controller has been offline for over 5 min. Its own timer will still end the session.", `offline-${l.sessionId}`);
      }
    } else {
      // Bake-out readings go on the session it's drying out after.
      await this.recordReading(l, l.sessionId ?? l.lastSessionId);
      // Controller ended the session on its own (its limit wins; we never restart it).
      if (r.heaterOn === false && l.startedAt && now - l.startedAt > 60_000) l.offStreak++;
      else l.offStreak = 0;
      if (l.offStreak >= 2) {
        if (l.mode === 'bakeout') await this.finishBakeout(l);
        else {
          await this.endSession(l, 'controller');
          await this.alert(l, 'The controller turned the heater off (its own limit or a manual stop at the panel).');
        }
        return;
      }
    }

    const f = l.lastReading?.f;

    if (l.mode === 'heating' && l.startedAt && l.targetF) {
      if (f !== undefined && r && f >= l.targetF) {
        l.mode = 'hot';
        l.reachedAt = now;
        await this.env.DB.prepare('UPDATE sessions SET reached_at = ? WHERE id = ?').bind(now, l.sessionId).run();
        await notify(this.env, 'owner', { title: 'Hot. Tell friends?', body: `${Math.round(f)}°F`, url: '/control', tag: 'hot-owner' });
      } else {
        if (!l.slowRiseChecked && now - l.startedAt >= SLOW_RISE_WINDOW_MS) {
          l.slowRiseChecked = true;
          if (f !== undefined && l.startTempF !== null && f - l.startTempF < SLOW_RISE_MIN_F) {
            await this.alert(l, `Only +${Math.round(f - l.startTempF)}°F in the first 10 min. Check the heater.`);
          }
        }
        if (now - l.startedAt > PREHEAT_CAP_MS) {
          try {
            await this.controller.heater(false);
          } catch {
            l.stopPending = true;
          }
          await this.endSession(l, 'preheat_cap');
          await this.alert(l, "Stopped: the sauna didn't reach temperature within 2.5 h.");
          return;
        }
      }
    }

    if ((l.mode === 'hot' || l.mode === 'heating') && l.leaveEndsAt && now >= l.leaveEndsAt) {
      try {
        await this.controller.heater(false);
      } catch (e) {
        l.stopPending = true;
        await this.handleError(l, e, 'Stop after leaving failed (retrying)');
      }
      await this.endSession(l, 'left');
      await this.planSchedules(l, true);
      return;
    }

    // Once the owner has left, the dry-out end time replaces the time-at-temperature timer.
    if (l.mode === 'hot' && !l.leaveEndsAt && l.reachedAt && now >= l.reachedAt + (l.atTempMin ?? AT_TEMP_MIN) * 60_000) {
      try {
        await this.controller.heater(false);
      } catch (e) {
        l.stopPending = true;
        await this.handleError(l, e, 'Auto-stop failed (retrying)');
      }
      await this.endSession(l, 'max_time');
    }

    if (l.mode === 'bakeout' && l.bakeoutEndsAt && now >= l.bakeoutEndsAt) {
      try {
        await this.controller.heater(false);
      } catch (e) {
        l.stopPending = true;
        await this.handleError(l, e, 'Bake-out stop failed (retrying)');
      }
      await this.finishBakeout(l);
    }

    await this.planSchedules(l, true);
  }

  /** Recompute start times from the latest prediction; fire any that are due. */
  private async planSchedules(l: Live, allowStart: boolean) {
    const now = Date.now();
    const pending = (await this.env.DB.prepare("SELECT * FROM schedules WHERE status = 'pending' ORDER BY hot_by").all<any>())
      .results;
    if (!pending.length) return;
    const runs = await this.cleanRuns();

    for (const sch of pending) {
      if (sch.hot_by < now - 30 * 60_000) {
        await this.env.DB.prepare("UPDATE schedules SET status = 'failed' WHERE id = ?").bind(sch.id).run();
        await this.alert(l, 'A scheduled session was missed.');
        continue;
      }
      // Refresh the room temperature when a start is getting close.
      if (sch.start_at && sch.start_at - now < 4 * 3600_000 && !this.freshTemp(l, 15 * 60_000) && l.mode === 'off') {
        await this.readDevice(l);
      }
      const startF = this.freshTemp(l) ?? 50;
      const pred = predictPreheat(runs, startF, sch.target_f);
      const startAt = Math.round(scheduledStart(sch.hot_by, pred.minutes));
      if (startAt !== sch.start_at || pred.minutes !== sch.predicted_min) {
        await this.env.DB.prepare('UPDATE schedules SET start_at = ?, predicted_min = ? WHERE id = ?')
          .bind(startAt, pred.minutes, sch.id)
          .run();
        sch.start_at = startAt;
      }
      if (allowStart && now >= startAt) {
        if (l.mode === 'heating' || l.mode === 'hot') {
          await this.env.DB.prepare("UPDATE schedules SET status = 'started', session_id = ? WHERE id = ?").bind(l.sessionId, sch.id).run();
          continue;
        }
        await this.save(l);
        try {
          await this.start(sch.target_f, { scheduleId: sch.id, bakeoutAfter: !!sch.bakeout_after });
          Object.assign(l, await this.live());
          // The owner isn't in the app when a scheduled start fires: nudge them to text whoever asked.
          const toText = await this.textList(l);
          if (toText.length) {
            await notify(this.env, 'owner', {
              title: 'Sauna’s on (scheduled)',
              body: `Tap to text ${toText.length === 1 ? toText[0].name : `the ${toText.length} people who asked`}.`,
              url: '/control',
              tag: 'text-friends',
            });
          }
          await this.env.DB.prepare("UPDATE schedules SET status = 'started', session_id = ? WHERE id = ?").bind(l.sessionId, sch.id).run();
        } catch {
          Object.assign(l, await this.live()); // start() already alerted the owner
          await this.env.DB.prepare("UPDATE schedules SET status = 'failed' WHERE id = ?").bind(sch.id).run();
        }
      }
    }
  }

  private async scheduleAlarm(l: Live) {
    const now = Date.now();
    const times: number[] = [];
    if (l.mode !== 'off' || l.stopPending) times.push(now + ACTIVE_POLL_MS);
    else if (this.cooldownWatch(l, now) && !(l.lastReading && l.lastReading.t > (l.lastEndedAt ?? 0))) {
      // First check soon after the heater goes off (a short session may already be cool).
      times.push(now + 15_000);
    } else times.push(now + IDLE_POLL_MS);
    const next = await this.env.DB.prepare(
      "SELECT MIN(start_at) AS t FROM schedules WHERE status = 'pending' AND start_at IS NOT NULL",
    ).first<{ t: number | null }>();
    if (next?.t) times.push(Math.max(now + 1000, Math.min(next.t, now + SCHEDULE_CHECK_MS)));
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }
}

/** Every session gets an hour at temperature (the controller's own session is 60 min). */
const AT_TEMP_MIN = 60;
