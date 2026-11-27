// Web Push mit WebCrypto (Cloudflare Workers, Browser, Node 18+):
// VAPID (RFC 8292) + Nutzlast-Verschlüsselung aes128gcm (RFC 8291).

const te = new TextEncoder();

export const b64u = {
  enc(buf) {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = String(str).replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64u.enc(pub), privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
}

/** Verschlüsselt die Nutzlast für ein Abo. `fixed` nur für den RFC-Testvektor. */
export async function encryptPayload(payload, p256dh, auth, fixed = {}) {
  const uaPublic = b64u.dec(p256dh), authSecret = b64u.dec(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('ungültiger p256dh-Schlüssel');
  if (authSecret.length < 16) throw new Error('ungültiges auth-Geheimnis');
  const asKeys = fixed.asJwk
    ? { privateKey: await crypto.subtle.importKey('jwk', fixed.asJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
        publicKey: await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: fixed.asJwk.x, y: fixed.asJwk.y }, { name: 'ECDH', namedCurve: 'P-256' }, true, []) }
    : await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const salt = fixed.salt ? b64u.dec(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));

  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(te.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, te.encode('Content-Encoding: aes128gcm\0\x01'))).slice(0, 16);
  const nonce = (await hmac(prk, te.encode('Content-Encoding: nonce\0\x01'))).slice(0, 12);

  const plain = concat(payload instanceof Uint8Array ? payload : te.encode(payload), new Uint8Array([2]));
  if (plain.length + 16 > 4096 - 86) throw new Error('Nutzlast zu groß');
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}

const jwtCache = new Map();
export async function vapidHeader(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const hit = jwtCache.get(aud);
  if (hit && hit.exp - now > 3600 && hit.pub === vapid.publicKey) return hit.header;
  const exp = now + 12 * 3600;
  const unsigned = `${b64u.enc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))}.${b64u.enc(te.encode(JSON.stringify({ aud, exp, sub: subject })))}`;
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(unsigned));
  const header = `vapid t=${unsigned}.${b64u.enc(sig)}, k=${vapid.publicKey}`;
  jwtCache.set(aud, { header, exp, pub: vapid.publicKey });
  return header;
}

/** Sendet eine Push-Nachricht; Ergebnis: HTTP-Status (201 = angenommen, 404/410 = Abo ungültig). */
export async function sendPush(subscription, data, vapid, subject, { ttl = 900, urgency = 'high' } = {}) {
  const body = await encryptPayload(JSON.stringify(data), subscription.keys.p256dh, subscription.keys.auth);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(subscription.endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 200);
  return { status: res.status, text };
}
