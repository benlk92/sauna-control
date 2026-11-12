import { checkPassphrase, clearCookie, clearFailures, isOwner, makeCookie, rateLimited, recordFailure, setPassphrase } from './auth';
import { notify } from './notify';
import { SCHEMA } from './schema';
import type { Env } from './types';

export { SaunaDO } from './sauna';

let schemaReady: Promise<unknown> | null = null;
function ensureSchema(env: Env) {
  schemaReady ??= env.DB.batch(
    SCHEMA.replace(/--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => env.DB.prepare(s)),
  )
    .then(() => migrate(env))
    .catch((e) => {
      schemaReady = null;
      throw e;
    });
  return schemaReady;
}

/** Columns added after the first deploy. CREATE TABLE IF NOT EXISTS won't add them to an existing table. */
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ['sessions', 'fx_predicted_min', 'REAL'],
  ['requests', 'phone', 'TEXT'],
  ['comers', 'phone', 'TEXT'],
  ['sessions', 'at_temp_min', 'REAL'],
  ['sessions', 'element_on_ms', 'INTEGER'],
  ['readings', 'heat_on', 'INTEGER'],
  ['sessions', 'left_at', 'INTEGER'],
  ['push_subs', 'name', 'TEXT'],
  ['requests', 'for_at', 'INTEGER'],
  ['comers', 'for_at', 'INTEGER'],
];

async function migrate(env: Env) {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    if (!results.some((c) => c.name === column)) {
      await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
    }
  }
}

/** Phones getting notifications, for the owner. The push service hints at the kind of phone. */
async function subscribers(env: Env) {
  const { results } = await env.DB.prepare('SELECT endpoint, role, name, created_at FROM push_subs ORDER BY role DESC, created_at').all<{
    endpoint: string;
    role: string;
    name: string | null;
    created_at: number;
  }>();
  const kind = (e: string) =>
    /push\.apple\.com/.test(e) ? 'iPhone' : /googleapis\.com/.test(e) ? 'Android / Chrome' : /mozilla/.test(e) ? 'Firefox' : /windows|wns/.test(e) ? 'Windows' : 'Browser';
  return results.map((r) => ({ endpoint: r.endpoint, role: r.role, name: r.name, since: r.created_at, kind: kind(r.endpoint) }));
}

async function wishlist(env: Env) {
  return (await env.DB.prepare('SELECT id, title, url FROM wishlist ORDER BY created_at').all<{ id: number; title: string; url: string | null }>()).results;
}

/** An optional link: null if blank, false if it isn't http(s). A bare "amazon.com/…" gets https:// added. */
function cleanUrl(raw: unknown): string | null | false {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().slice(0, 2000) : false;
  } catch {
    return false;
  }
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const err = (message: string, status = 400) => json({ error: message }, status);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // Notifications and Home Screen install need HTTPS; send plain-http visitors there.
    if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

    // Same-origin check for anything that changes state.
    if (req.method !== 'GET') {
      const origin = req.headers.get('Origin');
      if (origin && origin !== url.origin) return err('Bad origin', 403);
    }

    await ensureSchema(env);
    const sauna = env.SAUNA.get(env.SAUNA.idFromName('main'));
    const body = async () => (req.method === 'GET' ? {} : ((await req.json().catch(() => ({}))) as any));
    const route = `${req.method} ${url.pathname}`;

    try {
      // ---------- public ----------
      switch (route) {
        case 'GET /api/public/status':
          return json(await sauna.status(false, url.searchParams.get('client') ?? undefined));
        case 'POST /api/public/coming': {
          const b = await body();
          // phone: a string sets it, null removes it, absent keeps whatever was saved.
          const phone = b.phone === undefined ? undefined : b.phone === null ? null : String(b.phone);
          const forAt = b.forAt == null ? null : Number(b.forAt);
          return json(await sauna.coming(String(b.clientId ?? ''), String(b.name ?? ''), phone, forAt));
        }
        case 'POST /api/public/phone': {
          const b = await body();
          return json(await sauna.setPhone(String(b.clientId ?? ''), b.phone == null ? null : String(b.phone)));
        }
        case 'GET /api/public/wishlist':
          return json(await wishlist(env));
        case 'GET /api/vapid':
          return json({ publicKey: env.VAPID_PUBLIC_KEY ?? '' });
        case 'POST /api/push/subscribe': {
          const b = await body();
          const sub = b.subscription;
          if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return err('Bad subscription');
          if (!/^https:\/\//.test(sub.endpoint)) return err('Bad endpoint');
          // A phone has one push address, so one row. Only a signed-in owner can register as owner,
          // and a later friend sign-up on the owner's phone must not downgrade it.
          if (b.role === 'owner' && !(await isOwner(env, req))) return err('Sign in as the owner on this phone first', 403);
          const existing = await env.DB.prepare('SELECT role, name FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).first<{ role: string; name: string | null }>();
          const role = b.role === 'owner' || existing?.role === 'owner' ? 'owner' : 'friend';
          // The name lets the owner see who's subscribed (Settings → Notifications).
          const name = String(b.name ?? '').trim().slice(0, 40) || existing?.name || null;
          await env.DB.prepare('INSERT OR REPLACE INTO push_subs (endpoint, p256dh, auth, role, created_at, name) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth, role, Date.now(), name)
            .run();
          return json({ ok: true, role });
        }
        case 'POST /api/push/check': {
          // Lets a phone confirm what it's actually registered as, instead of trusting local memory.
          const b = await body();
          const row = await env.DB.prepare('SELECT role FROM push_subs WHERE endpoint = ?').bind(String(b.endpoint ?? '')).first<{ role: string }>();
          return json({ role: row?.role ?? null });
        }
        case 'POST /api/push/unsubscribe': {
          const b = await body();
          await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(String(b.endpoint ?? '')).run();
          return json({ ok: true });
        }
        case 'GET /api/me':
          return json({ owner: await isOwner(env, req) });
        case 'POST /api/login': {
          const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
          if (await rateLimited(env, ip)) return err('Too many attempts. Try again in 15 minutes.', 429);
          const b = await body();
          if (!(await checkPassphrase(env, String(b.passphrase ?? '')))) {
            await recordFailure(env, ip);
            return err('Wrong passphrase', 401);
          }
          await clearFailures(env, ip);
          const days = (await sauna.settings()).cookieDays;
          return json({ ok: true }, 200, { 'Set-Cookie': await makeCookie(env, days, url.protocol === 'https:') });
        }
        case 'POST /api/logout':
          return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
      }

      // ---------- owner ----------
      if (!(await isOwner(env, req))) return err('Passphrase required', 401);

      switch (route) {
        case 'GET /api/status':
          return json(await sauna.status(true));
        case 'POST /api/poke':
          await sauna.poke();
          return json(await sauna.status(true));
        case 'POST /api/start': {
          const b = await body();
          if (b.clear !== true) return err('Confirm the heater and benches are clear');
          await sauna.start(Number(b.targetF));
          return json(await sauna.status(true));
        }
        case 'POST /api/stop':
          await sauna.stop('manual');
          return json(await sauna.status(true));
        case 'POST /api/leave': {
          const b = await body();
          await sauna.leave(b.cancel === true);
          return json(await sauna.status(true));
        }
        case 'POST /api/alerts/clear':
          await sauna.clearAlerts();
          return json(await sauna.status(true));
        case 'GET /api/subscribers':
          return json(await subscribers(env));
        case 'POST /api/subscribers/remove': {
          const b = await body();
          await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(String(b.endpoint ?? '')).run();
          return json(await subscribers(env));
        }
        case 'POST /api/wishlist': {
          const b = await body();
          const title = String(b.title ?? '').trim().slice(0, 120);
          if (!title) return err('Give it a name');
          const link = cleanUrl(b.url);
          if (link === false) return err('Links need to start with http:// or https://');
          await env.DB.prepare('INSERT INTO wishlist (title, url, created_at) VALUES (?, ?, ?)').bind(title, link, Date.now()).run();
          return json(await wishlist(env));
        }
        case 'POST /api/target': {
          const b = await body();
          await sauna.changeTarget(Number(b.targetF));
          return json(await sauna.status(true));
        }
        case 'POST /api/bakeout': {
          const b = await body();
          if (b.ventsOpen !== true) return err('Open the low outlet and high vent first');
          await sauna.startBakeout();
          return json(await sauna.status(true));
        }
        case 'POST /api/schedule': {
          const b = await body();
          if (b.clear !== true) return err('Confirm the heater and benches are clear');
          await sauna.schedule(Number(b.hotBy), Number(b.targetF), !!b.bakeoutAfter);
          return json(await sauna.status(true));
        }
        case 'GET /api/schedule/preview':
          return json(await sauna.previewSchedule(Number(url.searchParams.get('hotBy')), Number(url.searchParams.get('targetF'))));
        case 'POST /api/tell':
          return json(await sauna.tellFriends());
        case 'GET /api/log':
          return json(await sauna.log());
        case 'GET /api/settings': {
          const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE role = 'friend'").first<{ n: number }>();
          const o = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE role = 'owner'").first<{ n: number }>();
          return json({ settings: await sauna.settings(), subscribers: n?.n ?? 0, ownerDevices: o?.n ?? 0 });
        }
        case 'POST /api/settings':
          return json({ settings: await sauna.saveSettings(await body()) });
        case 'POST /api/passphrase': {
          const b = await body();
          if (!(await checkPassphrase(env, String(b.current ?? '')))) return err('Current passphrase is wrong', 401);
          if (String(b.next ?? '').length < 6) return err('Use at least 6 characters');
          await setPassphrase(env, String(b.next));
          const days = (await sauna.settings()).cookieDays;
          return json({ ok: true }, 200, { 'Set-Cookie': await makeCookie(env, days, url.protocol === 'https:') });
        }
        case 'POST /api/push/test': {
          const sent = await notify(env, 'owner', { title: 'Test notification', body: 'Owner alerts are working.', url: '/settings', tag: 'test' });
          return json({ ok: true, sent });
        }
        case 'GET /api/debug/harvia':
          return json(await sauna.debugRaw());
        case 'POST /api/mock/offline': {
          const b = await body();
          return json(await sauna.mockOffline(!!b.offline));
        }
      }

      const w = url.pathname.match(/^\/api\/wishlist\/(\d+)$/);
      if (w && req.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM wishlist WHERE id = ?').bind(Number(w[1])).run();
        return json(await wishlist(env));
      }
      const m = url.pathname.match(/^\/api\/schedule\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        await sauna.cancelSchedule(Number(m[1]));
        return json(await sauna.status(true));
      }
      return err('Not found', 404);
    } catch (e) {
      console.error(route, e);
      return err((e as Error).message || 'Server error', 502);
    }
  },
} satisfies ExportedHandler<Env>;
