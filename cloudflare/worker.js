// Athan auf Cloudflare Workers (kostenlos): liefert die Web-App aus, verschickt jede Minute fällige
// Push-Benachrichtigungen (auch bei geschlossener App / gesperrtem Handy) und hält die Athan-Aufnahmen bereit.
// Speicher: ein KV-Namespace (Bindung ATHAN). Keine Datenbank nötig.
import { cleanSettings, cleanSubscription, subId, messagesFor, httpError, isAudio, barkPayload, BARK_URL, testData } from '../server/core.mjs';
import catalog from '../web/muezzins.json' with { type: 'json' };
import appConfig from '../web/config.json' with { type: 'json' };
import { generateVapidKeys, sendPush } from './webpush.js';

const MAX_SUBS = 1000;
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const subject = (env) => env.VAPID_SUBJECT || 'https://github.com/BasselHamadeh/Athan';
const testTimes = new Map();

async function getVapid(env) {
  let v = await env.ATHAN.get('vapid', 'json');
  if (!v?.publicKey || !v?.privateJwk) {
    v = await generateVapidKeys();
    await env.ATHAN.put('vapid', JSON.stringify(v));
  }
  return v;
}
const loadSubs = async (env) => (await env.ATHAN.get('subs', 'json')) || [];
const saveSubs = (env, subs) => env.ATHAN.put('subs', JSON.stringify(subs));

async function readJSON(req, max = 16384) {
  if (!(req.headers.get('content-type') || '').includes('application/json')) throw httpError(415, 'JSON erwartet');
  const len = +(req.headers.get('content-length') || 0);
  if (len > max) throw httpError(413, 'Zu groß');
  const text = await req.text();
  if (text.length > max) throw httpError(413, 'Zu groß');
  try { return JSON.parse(text || '{}'); } catch { throw httpError(400, 'Kein gültiges JSON'); }
}

// Öffentliche Adresse (für die Athan-Töne, die Bark lädt)
const publicOrigin = (env) => { try { return new URL(env.APP_URL || appConfig.appUrl).origin; } catch { return ''; } };

async function sendBark(env, s, data) {
  const r = await fetch(env.BARK_URL || BARK_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(barkPayload(s.settings, data, publicOrigin(env))), signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && (j.code === undefined || j.code === 200), status: r.status, text: j.message || '' };
}

/** iPhone mit Bark: Mitteilung mit Athan-Ton über Bark; sonst (oder falls Bark scheitert) Web-Push. */
async function deliver(env, vapid, s, data, ttl) {
  if (s.settings.bark) {
    try {
      const r = await sendBark(env, s, data);
      if (r.ok) return { status: 201, via: 'bark' };
      console.log('Bark abgelehnt', r.status, r.text);
    } catch (e) { console.log('Bark-Fehler', e.message); }
  }
  try {
    return { ...(await sendPush(s.subscription, data, vapid, subject(env), { ttl })), via: 'push' };
  } catch (e) {
    console.log('Push-Fehler', e.message);
    return { status: 0, text: e.message };
  }
}

async function api(req, env, url) {
  const p = url.pathname;
  if (p === '/api/config') {
    if (req.method !== 'GET') return json({ error: 'GET erwartet' }, 405);
    const v = await getVapid(env);
    return json({ push: true, audio: true, vapidPublicKey: v.publicKey });
  }
  if (req.method !== 'POST') return json({ error: 'POST erwartet' }, 405);
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'Fremde Herkunft' }, 403);
  const body = await readJSON(req);
  const allowAny = env.ATHAN_TEST_ENDPOINTS === '1';

  if (p === '/api/subscribe') {
    const subscription = cleanSubscription(body.subscription, allowAny);
    const settings = cleanSettings(body.settings);
    const id = await subId(subscription.endpoint);
    const subs = await loadSubs(env);
    const i = subs.findIndex((s) => s.id === id);
    if (i >= 0 && JSON.stringify(subs[i].subscription) === JSON.stringify(subscription) && JSON.stringify(subs[i].settings) === JSON.stringify(settings)) {
      return json({ ok: true, unchanged: true });
    }
    const entry = { id, subscription, settings, updated: Date.now() };
    if (i >= 0) subs[i] = entry;
    else if (subs.length >= MAX_SUBS) return json({ error: 'Server voll' }, 503);
    else subs.push(entry);
    await saveSubs(env, subs);
    return json({ ok: true });
  }
  if (p === '/api/unsubscribe') {
    const id = await subId(String(body.endpoint || ''));
    const subs = await loadSubs(env);
    if (subs.some((s) => s.id === id)) await saveSubs(env, subs.filter((s) => s.id !== id));
    return json({ ok: true });
  }
  if (p === '/api/test') {
    const id = await subId(String(body.endpoint || ''));
    const subs = await loadSubs(env);
    const s = subs.find((x) => x.id === id);
    if (!s) return json({ error: 'Abo unbekannt' }, 404);
    if (Date.now() - (testTimes.get(id) || 0) < 10000) return json({ error: 'Bitte kurz warten' }, 429);
    testTimes.set(id, Date.now());
    if (+body.delay > 0) {
      // Test bei gesperrtem Handy: der Minuten-Planer schickt ihn in ca. 1 Minute
      s.testAt = Math.floor(Date.now() / 60000) * 60000 + 60000;
      await saveSubs(env, subs);
      return json({ scheduled: true, at: s.testAt });
    }
    const r = await deliver(env, await getVapid(env), s, testMessage(s), 120);
    return json({ status: r.status, via: r.via }, r.status >= 200 && r.status < 300 ? 200 : 502);
  }
  return json({ error: 'Unbekannt' }, 404);
}

// Aufnahmen einmal holen und im KV ablegen – danach schnell, auch wenn die Quelle hakt.
async function audio(req, env, id) {
  const v = catalog.voices.find((x) => x.id === id);
  if (!v) return new Response('Unbekannte Stimme', { status: 404, headers: SEC });
  let buf = await env.ATHAN.get('audio:' + id, 'arrayBuffer');
  if (!buf) {
    for (const src of v.src) {
      try {
        const r = await fetch(src, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 AthanApp/1.1' } });
        if (!r.ok) continue;
        const b = await r.arrayBuffer();
        if (b.byteLength > 20e6 || !isAudio(new Uint8Array(b, 0, Math.min(16, b.byteLength)))) continue;
        buf = b;
        await env.ATHAN.put('audio:' + id, b);
        break;
      } catch (e) { console.log('Audio', id, e.message); }
    }
    if (!buf) return new Response('Quelle nicht erreichbar', { status: 502, headers: SEC });
  }
  return ranged(req, buf, 'audio/mpeg');
}

function ranged(req, buf, type) {
  const size = buf.byteLength;
  const base = { ...SEC, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=2592000, immutable' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
  if (!m || (m[1] === '' && m[2] === '')) {
    return new Response(req.method === 'HEAD' ? null : buf, { headers: { ...base, 'Content-Length': String(size) } });
  }
  let start = m[1] === '' ? size - +m[2] : +m[1];
  let end = m[1] !== '' && m[2] !== '' ? +m[2] : size - 1;
  if (start < 0) start = 0;
  if (start >= size || end < start) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
  end = Math.min(end, size - 1);
  return new Response(req.method === 'HEAD' ? null : buf.slice(start, end + 1), {
    status: 206, headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
  });
}

const testMessage = (s) => testData(s.settings);

/** Läuft jede Minute: verschickt alle Benachrichtigungen, die genau in dieser Minute fällig sind. */
export async function runMinute(scheduledTime, env) {
  const minute = Math.floor(scheduledTime / 60000) * 60000;
  const subs = await loadSubs(env);
  const due = [];
  let tests = 0;
  for (const s of subs) {
    for (const m of messagesFor(s.settings, minute - 60000, minute)) due.push({ s, m });
    if (s.testAt && s.testAt <= minute) { due.push({ s, m: { data: testMessage(s), ttl: 300 } }); delete s.testAt; tests++; }
  }
  if (tests) await saveSubs(env, subs);
  if (!due.length) return { sent: 0 };
  const vapid = await getVapid(env);
  const results = await Promise.all(due.map(async ({ s, m }) => ({ s, r: await deliver(env, vapid, s, m.data, m.ttl) })));
  const gone = new Set(results.filter(({ r }) => r.status === 404 || r.status === 410).map(({ s }) => s.id));
  for (const { r } of results) if (r.status >= 400) console.log('Push abgelehnt', r.status, r.text);
  if (gone.size) await saveSubs(env, subs.filter((s) => !gone.has(s.id)));
  return { sent: results.length, removed: gone.size };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      if (url.pathname === '/athan.caf' && req.method === 'GET') {
        // Athan-Ton zum Importieren in Bark („Custom Sounds“) – heißt immer athan.caf
        const v = /^[a-z0-9_]{1,40}$/.test(url.searchParams.get('v') || '') ? url.searchParams.get('v') : 'makkah_mulla';
        const r = await env.ASSETS.fetch(new Request(new URL(`/sounds/${v}.caf`, url.origin)));
        if (!r.ok) return new Response('Ton nicht gefunden', { status: 404, headers: SEC });
        return new Response(r.body, { headers: { ...SEC, 'Content-Type': 'audio/x-caf', 'Content-Disposition': 'attachment; filename="athan.caf"', 'Cache-Control': 'no-store' } });
      }
      const m = /^\/audio\/([a-z0-9_]{1,40})$/.exec(url.pathname);
      if (m && (req.method === 'GET' || req.method === 'HEAD')) return await audio(req, env, m[1]);
      return env.ASSETS.fetch(req);
    } catch (e) {
      return json({ error: e.status ? e.message : 'Ungültige Anfrage' }, e.status || 400);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMinute(event.scheduledTime, env).then((r) => { if (r.sent) console.log('Pushes', JSON.stringify(r)); }));
  },
};
