// Prints a VAPID keypair for web push. Put both in secrets (or .dev.vars locally).
const { subtle } = globalThis.crypto;
const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const pub = Buffer.from(await subtle.exportKey('raw', kp.publicKey)).toString('base64url');
const jwk = await subtle.exportKey('jwk', kp.privateKey);
console.log(`VAPID_PUBLIC_KEY=${pub}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
