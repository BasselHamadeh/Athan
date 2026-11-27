import { encryptPayload, decryptPayload, generateVapidKeys, vapidHeader, b64u } from '../server/webpush.mjs';
import crypto from 'node:crypto';
// RFC 8291, Anhang A
const v = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  expected: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const out = encryptPayload(Buffer.from(v.plaintext), v.uaPublic, v.auth, { asPrivate: v.asPrivate, salt: v.salt });
console.log('RFC 8291 Testvektor:', b64u.enc(out) === v.expected ? 'IDENTISCH ✓' : 'ABWEICHUNG ✗\n' + b64u.enc(out));
console.log('Entschlüsselt:', decryptPayload(out, v.uaPrivate, v.auth).toString());
// Zufälliger Roundtrip
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const auth = b64u.enc(crypto.randomBytes(16));
const msg = JSON.stringify({ title: 'Zeit für Asr (العصر)', body: '14:21 · Berlin' });
const enc = encryptPayload(Buffer.from(msg), b64u.enc(ua.getPublicKey()), auth);
console.log('Roundtrip:', decryptPayload(enc, b64u.enc(ua.getPrivateKey()), auth).toString() === msg ? 'OK ✓' : 'FEHLER');
// VAPID-JWT prüfen
const keys = generateVapidKeys();
const h = vapidHeader('https://web.push.apple.com/abc', keys, 'mailto:test@example.com');
const [, t, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
const [hd, cl, sig] = t.split('.');
const pubRaw = b64u.dec(k);
const jwk = { kty: 'EC', crv: 'P-256', x: b64u.enc(pubRaw.subarray(1, 33)), y: b64u.enc(pubRaw.subarray(33)) };
const ok = crypto.verify('sha256', Buffer.from(hd + '.' + cl), { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, b64u.dec(sig));
console.log('VAPID-Signatur:', ok ? 'gültig ✓' : 'UNGÜLTIG', JSON.parse(b64u.dec(cl)).aud);
