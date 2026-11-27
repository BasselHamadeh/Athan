import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { decryptPayload, b64u } from '../server/webpush.mjs';
import { computeDay } from '../web/js/praytimes.js';

const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const auth = b64u.enc(crypto.randomBytes(16));
const got = [];
const mock = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    try {
      const msg = JSON.parse(decryptPayload(Buffer.concat(chunks), b64u.enc(ua.getPrivateKey()), auth).toString());
      got.push({ msg, headers: { ttl: req.headers.ttl, urgency: req.headers.urgency, enc: req.headers['content-encoding'], auth: req.headers.authorization?.slice(0, 12) } });
    } catch (e) { got.push({ error: e.message }); }
    res.writeHead(201); res.end();
  });
}).listen(9911);

// Längengrad suchen, an dem Dhuhr vor ~1 Minute war
const now = Date.now(); const d = new Date(now);
let lon = null;
for (let x = -179; x <= 179; x += 0.02) {
  const t = computeDay({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }, { lat: 30, lon: x }, { method: 'MWL' });
  if (t.dhuhr <= now - 30000 && t.dhuhr > now - 120000) { lon = x; break; }
}
console.log('Testort: lat 30, lon', lon?.toFixed(2));
const srv = spawn('node', ['server/server.mjs'], { env: { ...process.env, PORT: '8099', DATA_DIR: '/tmp/athan-e2e', ATHAN_TEST_ENDPOINTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.on('data', (b) => process.stdout.write('  [server] ' + b));
srv.stderr.on('data', (b) => process.stdout.write('  [server-err] ' + b));
await new Promise((r) => setTimeout(r, 800));
const base = 'http://127.0.0.1:8099';
const cfg = await (await fetch(base + '/api/config')).json();
console.log('config:', { push: cfg.push, keyLen: b64u.dec(cfg.vapidPublicKey).length });
const sub = { endpoint: 'http://127.0.0.1:9911/push/abc', keys: { p256dh: b64u.enc(ua.getPublicKey()), auth } };
const settings = { location: { name: 'Testort', lat: 30, lon, tz: 'UTC' }, calc: { method: 'MWL' }, modes: { fajr: 'athan', sunrise: 'off', dhuhr: 'athan', asr: 'athan', maghrib: 'athan', isha: 'athan' }, pre: 0 };
let r = await fetch(base + '/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub, settings }) });
console.log('subscribe:', r.status, await r.text());
r = await fetch(base + '/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
console.log('test push:', r.status);
// Sicherheitsprüfungen
const bad = await fetch(base + '/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: { endpoint: 'https://x.y/', keys: { p256dh: 'abc', auth: 'x' } }, settings }) });
console.log('ungültige Schlüssel abgelehnt:', bad.status === 400);
const trav = await fetch(base + '/..%2f..%2fserver%2fserver.mjs');
console.log('Pfad-Traversal blockiert:', trav.status !== 200, trav.status);
const hdr = await fetch(base + '/');
console.log('CSP-Header:', !!hdr.headers.get('content-security-policy'), 'nosniff:', hdr.headers.get('x-content-type-options'));
console.log('warte auf Planer (≤ 22 s) …');
await new Promise((r) => setTimeout(r, 22000));
for (const g of got) console.log('EMPFANGEN:', JSON.stringify(g));
srv.kill('SIGTERM'); mock.close();
