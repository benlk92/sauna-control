import { b64urlDecode, b64urlEncode } from './push';
import type { Env } from './types';

const enc = new TextEncoder();
const COOKIE = 'sauna_owner';
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60_000;

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64urlEncode(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function safeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function pbkdf2(pass: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256);
  return b64urlEncode(bits);
}

async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function passVersion(env: Env): Promise<string> {
  return (await getSetting(env, 'pass_version')) ?? '0';
}

export async function checkPassphrase(env: Env, pass: string): Promise<boolean> {
  const stored = await getSetting(env, 'passphrase');
  if (stored) {
    const [salt, hash] = stored.split(':');
    return safeEqual(await pbkdf2(pass, b64urlDecode(salt)), hash);
  }
  return !!env.OWNER_PASSPHRASE && safeEqual(pass, env.OWNER_PASSPHRASE);
}

export async function setPassphrase(env: Env, pass: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const value = `${b64urlEncode(salt)}:${await pbkdf2(pass, salt)}`;
  const ver = String(Number(await passVersion(env)) + 1);
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('passphrase', value),
    env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('pass_version', ver),
  ]);
}

/** Returns a Set-Cookie header value. Changing the passphrase invalidates every cookie. */
export async function makeCookie(env: Env, days: number, secure: boolean): Promise<string> {
  const exp = Date.now() + days * 86400_000;
  const payload = `${exp}.${await passVersion(env)}`;
  const value = `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secure ? '; Secure' : ''}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function isOwner(env: Env, req: Request): Promise<boolean> {
  const cookie = req.headers.get('Cookie') ?? '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, ver, sig] = m[1].split('.');
  if (!exp || !ver || !sig || Number(exp) < Date.now()) return false;
  if (ver !== (await passVersion(env))) return false;
  return safeEqual(sig, await hmac(env.SESSION_SECRET, `${exp}.${ver}`));
}

export async function rateLimited(env: Env, ip: string): Promise<boolean> {
  const since = Date.now() - FAIL_WINDOW_MS;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at > ?')
    .bind(ip, since)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_FAILS;
}

export async function recordFailure(env: Env, ip: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO login_attempts (ip, at) VALUES (?, ?)').bind(ip, Date.now()),
    env.DB.prepare('DELETE FROM login_attempts WHERE at < ?').bind(Date.now() - 24 * 3600_000),
  ]);
}

export async function clearFailures(env: Env, ip: string): Promise<void> {
  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
}
