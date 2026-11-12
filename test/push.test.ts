import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { b64urlEncode, encryptPayload } from '../src/push';

const require = createRequire(import.meta.url);
const ece = require('http_ece');

describe('web push encryption', () => {
  it('produces a body the reference http_ece library decrypts', async () => {
    // A browser-side subscription keypair.
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const sub = { endpoint: 'https://push.example/x', p256dh: b64urlEncode(ua.getPublicKey()), auth: b64urlEncode(auth) };

    const body = await encryptPayload(sub, new TextEncoder().encode('{"title":"Sauna\'s hot"}'));
    const plain = ece.decrypt(Buffer.from(body), {
      version: 'aes128gcm',
      privateKey: ua,
      authSecret: auth,
    });
    expect(plain.toString()).toBe('{"title":"Sauna\'s hot"}');
  });
});
