#!/usr/bin/env node
// Athan-Server: liefert die Web-App aus, verschickt Push-Benachrichtigungen zu den Gebetszeiten
// und hält die Athan-Aufnahmen zwischengespeichert bereit. Keine Abhängigkeiten – nur Node 18+.
//
//   node server/server.mjs                 (Port 8080, Daten in ./data)
//   PORT=443 TLS_CERT=cert.pem TLS_KEY=key.pem VAPID_SUBJECT=mailto:du@example.org node server/server.mjs
//   node server/server.mjs --fetch-audio   (alle Aufnahmen vorab laden)

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateVapidKeys, sendPush } from './webpush.mjs';
import { upcomingEvents, isValidTimeZone, METHODS, PRAYERS } from '../web/js/praytimes.js';

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

const INFO = {
  fajr: ['Fajr', 'الفجر'], sunrise: ['Shuruq', 'الشروق'], dhuhr: ['Dhuhr', 'الظهر'], jumua: ['Jumu’a', 'الجمعة'],
  asr: ['Asr', 'العصر'], maghrib: ['Maghrib', 'المغرب'], isha: ['Isha', 'العشاء'],
};

function cleanSettings(s) {
  const l = s?.location;
  const lat = +l?.lat, lon = +l?.lon;
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) throw new Error('Ort fehlt');
  const tz = isValidTimeZone(String(l.tz)) ? String(l.tz) : 'UTC';
  const c = s.calc || {};
  const numIn = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
  const calc = {
    method: METHODS[c.method] ? c.method : 'MWL',
    asr: c.asr === 'hanafi' ? 'hanafi' : 'standard',
    highLat: ['angle', 'seventh', 'middle', 'none'].includes(c.highLat) ? c.highLat : 'angle',
    adjust: Object.fromEntries(PRAYERS.map((k) => [k, Math.round(numIn(c.adjust?.[k], -60, 60, 0))])),
    custom: { fajr: numIn(c.custom?.fajr, 5, 25, 18), isha: numIn(c.custom?.isha, 5, 25, 17), ishaMin: numIn(c.custom?.ishaMin, 0, 180, 0), maghribMin: numIn(c.custom?.maghribMin, 0, 60, 0) },
  };
  const modes = Object.fromEntries(PRAYERS.map((k) => [k, ['athan', 'notify', 'off'].includes(s.modes?.[k]) ? s.modes[k] : 'off']));
  return {
    location: { name: String(l.name || '').slice(0, 80), lat, lon, tz },
    calc, modes, pre: [0, 5, 10, 15, 20, 30].includes(+s.pre) ? +s.pre : 0, clock: s.clock === '12' ? '12' : '24',
  };
}
function cleanSubscription(sub) {
  const ep = new URL(String(sub?.endpoint || ''));
  if (!process.env.ATHAN_TEST_ENDPOINTS) {
    if (ep.protocol !== 'https:') throw new Error('Endpoint muss https sein');
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/.test(ep.hostname)) throw new Error('Endpoint nicht erlaubt');
  }
  const p256dh = String(sub.keys?.p256dh || ''), auth = String(sub.keys?.auth || '');
  if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length < 16) throw new Error('Schlüssel ungültig');
  return { endpoint: ep.href, keys: { p256dh, auth } };
}
const subId = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 32);

// ---------- Planer ----------
function fmtTime(epoch, tz, clock) {
  return new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: clock === '12' ? 'h12' : 'h23' }).format(epoch);
}
const isFriday = (epoch, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(epoch) === 'Fri';

async function deliver(s, data, ttl) {
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
    const { location, calc, modes, pre, clock } = s.settings;
    let events;
    try { events = upcomingEvents(location, calc, now - 5 * 60000, 1); } catch { continue; }
    s.sent ||= [];
    for (const e of events) {
      const mode = modes[e.prayer];
      if (mode === 'off') continue;
      const key = `${e.prayer}:${e.at}`;
      const kind = e.prayer === 'dhuhr' && isFriday(e.at, location.tz) ? 'jumua' : e.prayer;
      const [name, ar] = INFO[kind];
      if (e.at <= now && now - e.at < 5 * 60000 && !s.sent.includes(key)) {
        s.sent.push(key);
        jobs.push(deliver(s, {
          title: e.prayer === 'sunrise' ? `Sonnenaufgang (${ar})` : `Zeit für ${name} (${ar})`,
          body: `${fmtTime(e.at, location.tz, clock)} · ${location.name}`,
          tag: `prayer-${e.prayer}-${e.at}`, prayer: e.prayer, at: e.at, athan: mode === 'athan' && e.prayer !== 'sunrise', url: './#heute',
        }, 900));
      }
      const preAt = e.at - pre * 60000, pkey = 'pre:' + key;
      if (pre > 0 && preAt <= now && now - preAt < 5 * 60000 && e.at > now && !s.sent.includes(pkey)) {
        s.sent.push(pkey);
        jobs.push(deliver(s, { title: `${name} in ${pre} Minuten`, body: `Um ${fmtTime(e.at, location.tz, clock)} · ${location.name}`, tag: 'pre-' + key, url: './#heute' }, pre * 60));
      }
    }
    if (s.sent.length > 30) s.sent = s.sent.slice(-30);
  }
  if (jobs.length) { await Promise.allSettled(jobs); persist(); }
}

// ---------- Audio-Zwischenspeicher ----------
const inflight = new Map();
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  if (buf.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF') return 'audio/wav';
  return null;
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
  if (ct.startsWith('text/html')) base['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data: https:; connect-src 'self' https://geocoding-api.open-meteo.com https://nominatim.openstreetmap.org; worker-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";
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
    if (p.startsWith('/api/')) {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST erwartet' });
      if (limited(req)) return json(res, 429, { error: 'Zu viele Anfragen' });
      if (!(req.headers['content-type'] || '').includes('application/json')) return json(res, 415, { error: 'JSON erwartet' });
      const body = await readBody(req);
      if (p === '/api/subscribe') {
        const subscription = cleanSubscription(body.subscription);
        const settings = cleanSettings(body.settings);
        const id = subId(subscription.endpoint);
        if (!subs.has(id) && subs.size >= MAX_SUBS) return json(res, 503, { error: 'Server voll' });
        const old = subs.get(id);
        subs.set(id, { id, subscription, settings, sent: old?.sent || [], updated: Date.now() });
        persist();
        return json(res, 200, { ok: true });
      }
      if (p === '/api/unsubscribe') { subs.delete(subId(String(body.endpoint || ''))); persist(); return json(res, 200, { ok: true }); }
      if (p === '/api/test') {
        const s = subs.get(subId(String(body.endpoint || '')));
        if (!s) return json(res, 404, { error: 'Abo unbekannt' });
        const status = await deliver(s, { title: 'Athan – Test', body: `Benachrichtigungen für ${s.settings.location.name} funktionieren.`, tag: 'test', url: './#einstellungen' }, 120);
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
    return json(res, 400, { error: e.message || 'Fehler' });
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
