#!/usr/bin/env node
// Athan-Server: liefert die Web-App aus, verschickt Push-Benachrichtigungen zu den Gebetszeiten
// und hält die Athan-Aufnahmen zwischengespeichert bereit. Keine Abhängigkeiten – nur Node 18+.
//
//   node server/server.mjs                 (Port 8080, Daten in ./data)
//   PORT=443 TLS_CERT=cert.pem TLS_KEY=key.pem VAPID_SUBJECT=mailto:du@example.org node server/server.mjs
//   node server/server.mjs --fetch-audio   (alle Aufnahmen vorab laden)
//   PUBLIC_URL=https://athan.example.org   (für den Athan-Ton auf dem iPhone über Bark; Töne vorher mit
//                                           node scripts/athan-sounds.mjs --out web/sounds erzeugen)

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVapidKeys, sendPush } from './webpush.mjs';
import { cleanSettings, cleanSubscription, subId, messagesFor, isAudio, barkPayload, BARK_URL, testData, widgetSettings } from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(process.env.PUBLIC_DIR || path.join(HERE, '..', 'web'));
const DATA = path.resolve(process.env.DATA_DIR || path.join(HERE, '..', 'data'));
const PORT = +(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const MAX_SUBS = +(process.env.MAX_SUBSCRIPTIONS || 5000);
const TLS = process.env.TLS_CERT && process.env.TLS_KEY;

fs.mkdirSync(path.join(DATA, 'audio'), { recursive: true, mode: 0o700 });
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- VAPID-Schlüssel ----------
const vapidFile = path.join(DATA, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
catch { vapid = generateVapidKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); log('Neue VAPID-Schlüssel erzeugt'); }

// ---------- Abos ----------
const subsFile = path.join(DATA, 'subscriptions.json');
let subs = new Map();
try { for (const s of JSON.parse(fs.readFileSync(subsFile, 'utf8'))) subs.set(s.id, s); } catch { /* erster Start */ }
let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const tmp = subsFile + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify([...subs.values()]), { mode: 0o600 });
    await fsp.rename(tmp, subsFile);
  }, 300);
}

const catalog = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'muezzins.json'), 'utf8')).voices;
const voiceIds = new Set(catalog.map((v) => v.id));

// ---------- Planer ----------
async function deliver(s, data, ttl) {
  if (s.settings.bark && process.env.PUBLIC_URL) {
    try {
      const r = await fetch(BARK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(barkPayload(s.settings, data, new URL(process.env.PUBLIC_URL).origin)), signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && (j.code === undefined || j.code === 200)) return 201;
      log('Bark abgelehnt', r.status, j.message || '');
    } catch (e) { log('Bark-Fehler', e.message); }
  }
  try {
    const r = await sendPush(s.subscription, data, vapid, SUBJECT, { ttl });
    if (r.status === 404 || r.status === 410) { subs.delete(s.id); persist(); log('Abo abgelaufen, entfernt', s.id.slice(0, 8)); }
    else if (r.status >= 400) log('Push abgelehnt', r.status, r.text);
    return r.status;
  } catch (e) { log('Push-Fehler', e.message); return 0; }
}

async function schedulerTick() {
  const now = Date.now();
  const jobs = [];
  for (const s of subs.values()) {
    s.sent ||= [];
    for (const m of messagesFor(s.settings, now - 5 * 60000, now)) {
      if (s.sent.includes(m.key)) continue;
      s.sent.push(m.key);
      jobs.push(deliver(s, m.data, m.ttl));
    }
    if (s.sent.length > 30) s.sent = s.sent.slice(-30);
  }
  if (jobs.length) { await Promise.allSettled(jobs); persist(); }
}

// ---------- Audio-Zwischenspeicher ----------
const inflight = new Map();
function sniff(buf) {
  if (!isAudio(buf)) return null;
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  if (buf.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF') return 'audio/wav';
  return 'audio/mpeg';
}
async function ensureAudio(id) {
  const file = path.join(DATA, 'audio', id + '.bin');
  try { await fsp.access(file); return file; } catch {}
  if (inflight.has(id)) return inflight.get(id);
  const job = (async () => {
    const v = catalog.find((x) => x.id === id);
    for (const url of v.src) {
      try {
        const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'Mozilla/5.0 AthanApp/1.0' } });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 40 * 1024 * 1024 || !sniff(buf)) continue;
        await fsp.writeFile(file + '.tmp', buf); await fsp.rename(file + '.tmp', file);
        log('Aufnahme geladen', id, Math.round(buf.length / 1024) + ' KB');
        return file;
      } catch (e) { log('Download fehlgeschlagen', id, e.message); }
    }
    throw new Error('Quelle nicht erreichbar');
  })();
  inflight.set(id, job);
  try { return await job; } finally { inflight.delete(id); }
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  ...(TLS ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SEC, ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

const hits = new Map();
function limited(req) {
  const ip = req.socket.remoteAddress || '?';
  const now = Date.now();
  const h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  h.n++; hits.set(ip, h);
  return h.n > 30;
}
setInterval(() => { const cut = Date.now() - 120000; for (const [k, v] of hits) if (v.t < cut) hits.delete(k); }, 60000).unref();

function readBody(req, max = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('zu groß')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('kein JSON')); } });
    req.on('error', reject);
  });
}

async function serveFile(req, res, file, { cache = 'public, max-age=300', type } = {}) {
  let st;
  try { st = await fsp.stat(file); if (!st.isFile()) throw 0; } catch { return send(res, 404, 'Nicht gefunden', { 'Content-Type': 'text/plain; charset=utf-8' }); }
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const ct = type || MIME[path.extname(file)] || 'application/octet-stream';
  const base = { 'Content-Type': ct, 'Cache-Control': cache, ETag: etag, 'Accept-Ranges': 'bytes' };
  if (ct.startsWith('text/html')) base['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data: https://dl2.islamweb.net https://audio.islamweb.net; connect-src 'self' https://geocoding-api.open-meteo.com https://nominatim.openstreetmap.org; worker-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
  if (req.headers['if-none-match'] === etag) return send(res, 304, null, base);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] === '' ? st.size - +range[2] : +range[1];
    let end = range[1] !== '' && range[2] !== '' ? +range[2] : st.size - 1;
    if (start < 0 || start >= st.size || end < start) return send(res, 416, null, { ...base, 'Content-Range': `bytes */${st.size}` });
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...SEC, ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...SEC, ...base, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    // --- API ---
    if (p === '/api/config') return json(res, 200, { push: true, audio: true, vapidPublicKey: vapid.publicKey });
    if (p === '/api/widget' && req.method === 'GET') {
      const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
      const s = /^[0-9a-f]{32}$/.test(id) ? subs.get(id) : null;
      return s ? json(res, 200, widgetSettings(s.settings)) : json(res, 404, { error: 'Unbekannt' });
    }
    if (p.startsWith('/api/')) {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST erwartet' });
      if (limited(req)) return json(res, 429, { error: 'Zu viele Anfragen' });
      if (!(req.headers['content-type'] || '').includes('application/json')) return json(res, 415, { error: 'JSON erwartet' });
      const body = await readBody(req);
      if (p === '/api/subscribe') {
        const subscription = cleanSubscription(body.subscription, !!process.env.ATHAN_TEST_ENDPOINTS);
        const settings = cleanSettings(body.settings);
        const id = await subId(subscription.endpoint);
        if (!subs.has(id) && subs.size >= MAX_SUBS) return json(res, 503, { error: 'Server voll' });
        const old = subs.get(id);
        subs.set(id, { id, subscription, settings, sent: old?.sent || [], updated: Date.now() });
        persist();
        return json(res, 200, { ok: true });
      }
      if (p === '/api/unsubscribe') { subs.delete(await subId(String(body.endpoint || ''))); persist(); return json(res, 200, { ok: true }); }
      if (p === '/api/test') {
        const s = subs.get(await subId(String(body.endpoint || '')));
        if (!s) return json(res, 404, { error: 'Abo unbekannt' });
        const msg = testData(s.settings);
        if (+body.delay > 0) { setTimeout(() => deliver(s, testData(s.settings), 300), 60000).unref?.(); return json(res, 200, { scheduled: true }); }
        const status = await deliver(s, msg, 120);
        return json(res, status >= 200 && status < 300 ? 200 : 502, { status });
      }
      return json(res, 404, { error: 'Unbekannt' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, null, { Allow: 'GET, HEAD' });

    // --- Audio ---
    const am = /^\/audio\/([a-z0-9_]{1,40})$/.exec(p);
    if (am) {
      if (!voiceIds.has(am[1])) return send(res, 404, 'Unbekannte Stimme');
      let file;
      try { file = await ensureAudio(am[1]); } catch { return send(res, 502, 'Quelle nicht erreichbar', { 'Content-Type': 'text/plain; charset=utf-8' }); }
      const head = Buffer.alloc(16); const fd = await fsp.open(file); await fd.read(head, 0, 16, 0); await fd.close();
      return serveFile(req, res, file, { cache: 'public, max-age=2592000, immutable', type: sniff(head) || 'audio/mpeg' });
    }

    // --- Statische Dateien ---
    let rel = p === '/' ? '/index.html' : p;
    const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Verboten');
    const noCache = /(index\.html|sw\.js|manifest\.webmanifest)$/.test(file);
    return serveFile(req, res, file, { cache: noCache ? 'no-cache' : 'public, max-age=3600' });
  } catch (e) {
    return json(res, e.status || 400, { error: e.message || 'Fehler' });
  }
}

// ---------- Start ----------
if (process.argv.includes('--fetch-audio')) {
  for (const v of catalog) { try { await ensureAudio(v.id); } catch (e) { log('✗', v.id, e.message); } }
  process.exit(0);
}

const server = TLS
  ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handler)
  : http.createServer(handler);
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(PORT, HOST, () => log(`Athan-Server läuft auf ${TLS ? 'https' : 'http'}://${HOST}:${PORT}  (Abos: ${subs.size})`));
setInterval(() => schedulerTick().catch((e) => log('Planer', e.message)), 20000);
schedulerTick();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  clearTimeout(saveTimer);
  await fsp.writeFile(subsFile, JSON.stringify([...subs.values()]), { mode: 0o600 }).catch(() => {});
  process.exit(0);
});
