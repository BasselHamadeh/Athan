// Web Push ohne Abhängigkeiten: VAPID (RFC 8292) + Verschlüsselung aes128gcm (RFC 8291)
import crypto from 'node:crypto';

export const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64url'),
  dec: (s) => Buffer.from(String(s), 'base64url'),
};

export function generateVapidKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const prv = privateKey.export({ format: 'jwk' });
  return { publicKey: rawPublic(pub), privateJwk: prv };
}
function rawPublic(jwk) {
  return b64u.enc(Buffer.concat([Buffer.from([4]), b64u.dec(jwk.x), b64u.dec(jwk.y)]));
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Verschlüsselt die Nutzlast für ein Abo. `fixed` nur für Tests (RFC-8291-Testvektor). */
export function encryptPayload(payload, p256dh, auth, fixed = {}) {
  const uaPublic = b64u.dec(p256dh);
  const authSecret = b64u.dec(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('ungültiger p256dh-Schlüssel');
  if (authSecret.length < 16) throw new Error('ungültiges auth-Geheimnis');
  const ecdh = crypto.createECDH('prime256v1');
  if (fixed.asPrivate) ecdh.setPrivateKey(b64u.dec(fixed.asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed.salt ? b64u.dec(fixed.salt) : crypto.randomBytes(16);

  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);

  const rs = 4096;
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  if (plain.length + 16 > rs - 86) throw new Error('Nutzlast zu groß');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1 + asPublic.length);
  salt.copy(header, 0); header.writeUInt32BE(rs, 16); header[20] = asPublic.length; asPublic.copy(header, 21);
  return Buffer.concat([header, ct]);
}

/** Gegenstück zum Testen (so entschlüsselt der Browser). */
export function decryptPayload(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(b64u.dec(uaPrivate));
  const uaPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(asPublic);
  const prkKey = hmac(b64u.dec(auth), shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1; while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error('falscher Trenner');
  return plain.subarray(0, end);
}

export function vapidHeader(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u.enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u.enc(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: vapid.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u.enc(sig)}, k=${vapid.publicKey}`;
}

/** Sendet eine Push-Nachricht. Gibt den HTTP-Status zurück (201 = angenommen, 404/410 = Abo ungültig). */
export async function sendPush(subscription, data, vapid, subject, { ttl = 600, urgency = 'high' } = {}) {
  const body = encryptPayload(Buffer.from(JSON.stringify(data)), subscription.keys.p256dh, subscription.keys.auth);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(subscription.endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const text = res.ok ? '' : await res.text().catch(() => '');
  return { status: res.status, text: text.slice(0, 200) };
}
