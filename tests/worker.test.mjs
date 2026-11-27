// Testet den Cloudflare Worker lokal in Node (ohne Cloudflare): Verschlüsselung, Abo, Minuten-Planer,
// Sicherheitsprüfungen und Audio-Auslieferung. Ein nachgebauter Push-Dienst entschlüsselt wie ein Handy.
import http from 'node:http';
import nodeCrypto from 'node:crypto';
import assert from 'node:assert/strict';
import { encryptPayload, b64u } from '../cloudflare/webpush.js';
import { decryptPayload } from '../server/webpush.mjs';
import worker, { runMinute } from '../cloudflare/worker.js';
import { computeDay } from '../web/js/praytimes.js';

let failed = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' – ' + extra : ''}`); if (!cond) failed++; };

// 1) RFC 8291, Anhang A – identische Ausgabe mit WebCrypto
{
  const asPrivate = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
  const ecdh = nodeCrypto.createECDH('prime256v1'); ecdh.setPrivateKey(Buffer.from(asPrivate, 'base64url'));
  const pub = ecdh.getPublicKey();
  const asJwk = { kty: 'EC', crv: 'P-256', d: asPrivate, x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33)) };
  const out = await encryptPayload('When I grow up, I want to be a watermelon',
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg',
    { asJwk, salt: 'DGv6ra1nlYgDCS1FRnbzlw' });
  ok('RFC-8291-Testvektor (WebCrypto)', b64u.enc(out) === 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
}

// 2) Nachgebauter Push-Dienst
const ua = nodeCrypto.createECDH('prime256v1'); ua.generateKeys();
const auth = b64u.enc(nodeCrypto.randomBytes(16));
const inbox = [];
let respondStatus = 201;
const mock = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try { inbox.push({ msg: JSON.parse(decryptPayload(Buffer.concat(chunks), b64u.enc(ua.getPrivateKey()), auth).toString()), ttl: req.headers.ttl, authz: req.headers.authorization }); }
    catch (e) { inbox.push({ error: e.message }); }
    res.writeHead(respondStatus); res.end();
  });
}).listen(0);
await new Promise((r) => mock.once('listening', r));
const endpoint = `http://127.0.0.1:${mock.address().port}/push/abc`;

// 3) Umgebung wie bei Cloudflare
class KV {
  m = new Map(); writes = 0;
  async get(k, type) { const v = this.m.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; }
  async put(k, v) { this.writes++; this.m.set(k, v); }
}
const env = { ATHAN: new KV(), ASSETS: { fetch: () => new Response('asset') }, VAPID_SUBJECT: 'https://example.org', ATHAN_TEST_ENDPOINTS: '1' };
const call = (path, opts = {}) => worker.fetch(new Request('https://athan.test' + path, opts), env);
const post = (path, body, headers = {}) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

const cfg = await (await call('/api/config')).json();
ok('/api/config liefert VAPID-Schlüssel', b64u.dec(cfg.vapidPublicKey).length === 65);
ok('VAPID-Schlüssel bleibt gleich', (await (await call('/api/config')).json()).vapidPublicKey === cfg.vapidPublicKey);

const berlin = { name: 'Berlin', lat: 52.52, lon: 13.405, tz: 'Europe/Berlin' };
const settings = { location: berlin, calc: { method: 'MWL' }, modes: { fajr: 'athan', sunrise: 'off', dhuhr: 'athan', asr: 'notify', maghrib: 'athan', isha: 'athan' }, pre: 10 };
const subscription = { endpoint, keys: { p256dh: b64u.enc(ua.getPublicKey()), auth } };
let r = await post('/api/subscribe', { subscription, settings });
ok('Abo angelegt', r.status === 200);
const w = env.ATHAN.writes;
r = await (await post('/api/subscribe', { subscription, settings })).json();
ok('Unverändertes Abo schreibt nicht erneut', r.unchanged === true && env.ATHAN.writes === w);
{ // iPhone-Widget holt Ort und Berechnung
  const { subId } = await import('../server/core.mjs');
  const id = await subId(new URL(endpoint).href);
  const wj = await (await call('/api/widget?id=' + id)).json();
  ok('Widget-Einstellungen abrufbar', wj.name === 'Berlin' && wj.lat === 52.52 && wj.tz === 'Europe/Berlin' && wj.calc.method === 'MWL' && !('modes' in wj) && !('bark' in wj));
  ok('Widget: unbekannte Kennung → 404', (await call('/api/widget?id=' + 'f'.repeat(32))).status === 404);
  ok('Widget: ungültige Kennung → 400', (await call('/api/widget?id=../x')).status === 400);
}

// 4) Planer: genau zur Gebetsminute (Freitag, 27.11.2026 – heißt trotzdem Dhuhr)
const t = computeDay({ y: 2026, m: 11, d: 27 }, berlin, { method: 'MWL' });
let res = await runMinute(t.dhuhr - 60000, env);
ok('Eine Minute vorher: nichts', res.sent === 0);
res = await runMinute(t.dhuhr + 7000, env);
await new Promise((r) => setTimeout(r, 100));
const jum = inbox.find((x) => x.msg?.prayer === 'dhuhr');
ok('Push zur Dhuhr-Minute', res.sent === 1 && !!jum, jum?.msg.title);
ok('Freitag heißt Dhuhr (nicht Jumu’a)', jum?.msg.title === 'Zeit für Dhuhr (الظهر)', jum?.msg.title);
ok('Athan-Kennzeichen gesetzt', jum?.msg.athan === true);
ok('VAPID-Kopf vorhanden', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/.test(jum?.authz || ''));
res = await runMinute(t.asr - 10 * 60000, env);
await new Promise((r) => setTimeout(r, 100));
ok('Erinnerung 10 Min. vor Asr', res.sent === 1 && inbox.at(-1).msg.title === 'Asr in 10 Minuten', inbox.at(-1).msg?.title);
res = await runMinute(t.asr, env);
await new Promise((r) => setTimeout(r, 100));
ok('Asr nur als Hinweis (kein Athan-Kennzeichen)', res.sent === 1 && inbox.at(-1).msg.athan === false);
res = await runMinute(t.sunrise, env);
ok('Shuruq aus: kein Push', res.sent === 0);
// ganzer Tag: jede Gebetsminute genau einmal
let count = 0;
for (let m = Math.floor(t.fajr / 60000) * 60000 - 3600000; m <= t.isha + 3600000; m += 60000) count += (await runMinute(m, env)).sent;
ok('Ganzer Tag: 4 Athan + 1 Hinweis + 5 Erinnerungen = 10 Pushes', count === 10, String(count));

// 5) Test-Knopf
r = await post('/api/test', { endpoint });
ok('Test-Push', r.status === 200);
r = await post('/api/test', { endpoint });
ok('Test-Push gedrosselt', r.status === 429);
await new Promise((r) => setTimeout(r, 10)); 
{ // Test in 1 Minute: Planer verschickt ihn in der nächsten Minute
  const { default: w2 } = await import('../cloudflare/worker.js?delay');
  const rr = await w2.fetch(new Request('https://athan.test/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, delay: 60 }) }), env);
  const j = await rr.json();
  ok('Test in 1 Minute eingeplant', j.scheduled === true && j.at > Date.now());
  const before = inbox.length;
  ok('Vorher nichts', (await runMinute(j.at - 60000, env)).sent === 0);
  const r2 = await runMinute(j.at + 1000, env);
  await new Promise((r) => setTimeout(r, 100));
  ok('Test-Mitteilung nach 1 Minute (wie echtes Gebet)', r2.sent === 1 && inbox.length === before + 1 && inbox.at(-1).msg.title.startsWith('Zeit für') && inbox.at(-1).msg.athan === true, inbox.at(-1)?.msg.title);
  ok('Nur einmal', (await runMinute(j.at + 61000, env)).sent === 0);
}

// 6) Sicherheit
const strict = { ...env, ATHAN_TEST_ENDPOINTS: undefined };
const postStrict = (body) => worker.fetch(new Request('https://athan.test/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), strict);
ok('Fremder Push-Host abgelehnt', (await postStrict({ subscription: { ...subscription, endpoint: 'https://evil.example/x' }, settings })).status === 400);
ok('http-Endpoint abgelehnt', (await postStrict({ subscription: { ...subscription, endpoint: 'http://web.push.apple.com/x' }, settings })).status === 400);
ok('Apple-Endpoint erlaubt', (await postStrict({ subscription: { ...subscription, endpoint: 'https://web.push.apple.com/QGx' }, settings })).status === 200);
ok('Fremde Herkunft abgelehnt', (await post('/api/subscribe', { subscription, settings }, { Origin: 'https://evil.example' })).status === 403);
ok('Kein JSON abgelehnt', (await call('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status === 415);
ok('Zu große Anfrage abgelehnt', (await post('/api/subscribe', { pad: 'x'.repeat(20000) })).status === 413);
ok('Ungültiger Ort abgelehnt', (await post('/api/subscribe', { subscription, settings: { ...settings, location: { lat: 999 } } })).status === 400);
ok('GET auf POST-Route abgelehnt', (await call('/api/subscribe')).status === 405);
ok('Statische Dateien über ASSETS', (await (await call('/index.html')).text()) === 'asset');
{ const d = await call('/athan.caf?v=abdulbaset'); ok('Bark-Import: athan.caf zum Laden', d.status === 200 && d.headers.get('content-disposition') === 'attachment; filename="athan.caf"' && d.headers.get('content-type') === 'audio/x-caf'); }

// 7) Abgelaufenes Abo wird entfernt
respondStatus = 410;
await runMinute(t.maghrib, env);
ok('410 → Abo gelöscht', (await env.ATHAN.get('subs', 'json')).every((s) => s.subscription.endpoint !== endpoint));
respondStatus = 201;

// 8) Audio: einmal laden, dann aus KV, mit Range (Safari)
const fake = new Uint8Array(5000); fake.set([0x49, 0x44, 0x33, 4]);
const realFetch = globalThis.fetch;
let audioFetches = 0;
globalThis.fetch = async (u, o) => (String(u).includes('islamweb') ? (audioFetches++, new Response(fake, { headers: { 'Content-Type': 'audio/mpeg' } })) : realFetch(u, o));
let a = await call('/audio/makkah_mulla');
ok('Audio geladen', a.status === 200 && a.headers.get('content-type') === 'audio/mpeg' && (await a.arrayBuffer()).byteLength === 5000);
a = await call('/audio/makkah_mulla', { headers: { Range: 'bytes=0-1' } });
ok('Range 0-1 → 206', a.status === 206 && a.headers.get('content-range') === 'bytes 0-1/5000' && (await a.arrayBuffer()).byteLength === 2);
a = await call('/audio/makkah_mulla', { headers: { Range: 'bytes=4000-' } });
ok('Range 4000- → 206', a.status === 206 && a.headers.get('content-range') === 'bytes 4000-4999/5000');
ok('Quelle nur einmal geladen', audioFetches === 1, String(audioFetches));
ok('Unbekannte Stimme → 404', (await call('/audio/gibtsnicht')).status === 404);
globalThis.fetch = realFetch;

// 9) iPhone mit Bark: Athan als Mitteilungston (soundUrl), Ersatz über Web-Push
{
  const bark = [];
  let barkOk = true;
  globalThis.fetch = async (u, o) => {
    if (String(u) === 'https://api.day.app/push') {
      bark.push(JSON.parse(o.body));
      return barkOk ? Response.json({ code: 200, message: 'success' }) : Response.json({ code: 400, message: 'failed to get device token' }, { status: 400 });
    }
    return realFetch(u, o);
  };
  const ep2 = endpoint.replace('/abc', '/bark');
  const sub2 = { ...subscription, endpoint: ep2 };
  const key = 'ynJ5Ft4atkMkWeo2PAvFhF';
  const st = { ...settings, pre: 10, sound: { fajr: 'makkah_fajr', other: 'abdulbaset' }, bark: { key, critical: false } };
  ok('Abo mit Bark angelegt', (await post('/api/subscribe', { subscription: sub2, settings: st })).status === 200);
  const saved = (await env.ATHAN.get('subs', 'json')).find((x) => x.subscription.endpoint === ep2);
  ok('Bark-Schlüssel gespeichert', saved?.settings.bark?.key === key && saved.settings.sound.other === 'abdulbaset');
  // nur dieses Abo betrachten
  const all = await env.ATHAN.get('subs', 'json');
  await env.ATHAN.put('subs', JSON.stringify(all.filter((x) => x.subscription.endpoint === ep2)));
  const pushes = inbox.length;
  let rr = await runMinute(t.dhuhr, env);
  const d = bark.at(-1);
  ok('Dhuhr über Bark', rr.sent === 1 && bark.length === 1 && inbox.length === pushes, d?.title);
  ok('Bark: Athan-Ton als soundUrl, Ersatz = importierter „athan“', d?.soundUrl === 'https://athan.basselhamadeh3.workers.dev/sounds/abdulbaset.caf' && d.sound === 'athan');
  ok('Bark: zeitkritisch, Gruppe, Symbol', d?.level === 'timeSensitive' && d.group === 'Athan' && d.icon.endsWith('/icons/icon-192.png') && d.device_key === key);
  const tf = computeDay({ y: 2026, m: 11, d: 28 }, berlin, { method: 'MWL' });
  await runMinute(tf.fajr, env);
  ok('Fajr mit Fajr-Stimme', bark.at(-1)?.soundUrl.endsWith('/sounds/makkah_fajr.caf'), bark.at(-1)?.soundUrl);
  await runMinute(t.asr - 10 * 60000, env);
  ok('Erinnerung ohne Athan-Ton', bark.at(-1)?.title === 'Asr in 10 Minuten' && !bark.at(-1).soundUrl && bark.at(-1).level === 'active');
  await runMinute(t.asr, env);
  ok('Nur Hinweis: ohne Athan-Ton', bark.at(-1)?.title.startsWith('Zeit für Asr') && !bark.at(-1).soundUrl);
  // Test-Knopf → Bark mit Athan-Ton
  const tr = await (await post('/api/test', { endpoint: ep2 })).json();
  ok('Test wie echtes Gebet (Text + Athan-Ton)', tr.via === 'bark' && /^Zeit für \w+ \(/.test(bark.at(-1)?.title) && bark.at(-1).body.endsWith('· Berlin') && /\/(abdulbaset|makkah_fajr)\.caf$/.test(bark.at(-1).soundUrl), bark.at(-1)?.title);
  // auch bei Lautlos (kritischer Hinweis)
  await post('/api/subscribe', { subscription: sub2, settings: { ...st, bark: { key, critical: true } } });
  await runMinute(t.maghrib, env);
  ok('Kritisch: läutet auch bei Lautlos', bark.at(-1)?.level === 'critical' && bark.at(-1).volume === 8);
  // Bark lehnt ab → Web-Push als Ersatz
  barkOk = false;
  const before = inbox.length;
  await runMinute(t.isha, env);
  await new Promise((r) => setTimeout(r, 100));
  ok('Bark-Fehler → Web-Push', inbox.length === before + 1 && inbox.at(-1).msg.prayer === 'isha');
  barkOk = true;
  // ungültiger Schlüssel wird verworfen
  await post('/api/subscribe', { subscription: sub2, settings: { ...st, bark: { key: 'https://evil.example/x' } } });
  ok('Ungültiger Bark-Schlüssel verworfen', (await env.ATHAN.get('subs', 'json')).find((x) => x.subscription.endpoint === ep2)?.settings.bark === null);
  globalThis.fetch = realFetch;
}

mock.close();
console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Worker-Tests bestanden');
process.exit(failed ? 1 : 0);
