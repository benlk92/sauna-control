import { sendPush, type PushMessage } from './push';
import type { Env } from './types';

export type Role = 'owner' | 'friend';

/** Send to every subscription with this role; prune ones the push service says are gone. */
export async function notify(env: Env, role: Role, msg: PushMessage): Promise<number> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.log(`[push:${role}] (no VAPID keys) ${msg.title}: ${msg.body}`);
    return 0;
  }
  const { results } = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE role = ?')
    .bind(role)
    .all<{ endpoint: string; p256dh: string; auth: string }>();
  const keys = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT };
  let sent = 0;
  await Promise.all(
    results.map(async (sub) => {
      try {
        const r = await sendPush(sub, msg, keys);
        if (r === 'gone') await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
        if (r === 'ok') sent++;
      } catch (e) {
        console.warn('push error', e);
      }
    }),
  );
  console.log(`[push:${role}] ${msg.title}: ${msg.body} → ${sent}/${results.length}`);
  return sent;
}
