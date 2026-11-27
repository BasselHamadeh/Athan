// Gemeinsamer Kern für Push-Server (Node) und Cloudflare Worker – ohne Abhängigkeiten,
// nur Web-Standards (läuft in Node 18+ und in Workers).
import { upcomingEvents, isValidTimeZone, METHODS, PRAYERS } from '../web/js/praytimes.js';

export const INFO = {
  fajr: ['Fajr', 'الفجر'], sunrise: ['Shuruq', 'الشروق'], dhuhr: ['Dhuhr', 'الظهر'], jumua: ['Jumu’a', 'الجمعة'],
  asr: ['Asr', 'العصر'], maghrib: ['Maghrib', 'المغرب'], isha: ['Isha', 'العشاء'],
};

// Nur echte Push-Dienste der Browser-Hersteller – verhindert, dass der Server beliebige Adressen anfragt.
const PUSH_HOSTS = [
  /(^|\.)push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)notify\.windows\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
];

function b64uLength(s) {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return -1;
  try { return atob(s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '') + '='.repeat((4 - (s.replace(/=+$/, '').length % 4)) % 4)).length; } catch { return -1; }
}

export function cleanSubscription(sub, allowAnyEndpoint = false) {
  let ep;
  try { ep = new URL(String(sub?.endpoint || '')); } catch { throw httpError(400, 'Endpoint ungültig'); }
  if (!allowAnyEndpoint) {
    if (ep.protocol !== 'https:') throw httpError(400, 'Endpoint muss https sein');
    if (!PUSH_HOSTS.some((r) => r.test(ep.hostname))) throw httpError(400, 'Unbekannter Push-Dienst');
  }
  const p256dh = String(sub.keys?.p256dh || ''), auth = String(sub.keys?.auth || '');
  if (b64uLength(p256dh) !== 65 || b64uLength(auth) < 16) throw httpError(400, 'Schlüssel ungültig');
  return { endpoint: ep.href, keys: { p256dh, auth } };
}

export function cleanSettings(s) {
  const l = s?.location;
  const lat = +l?.lat, lon = +l?.lon;
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) throw httpError(400, 'Ort fehlt');
  const tz = isValidTimeZone(String(l.tz)) ? String(l.tz) : 'UTC';
  const c = s.calc || {};
  const numIn = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
  const calc = {
    method: Object.hasOwn(METHODS, c.method) ? c.method : 'MWL',
    asr: c.asr === 'hanafi' ? 'hanafi' : 'standard',
    highLat: ['angle', 'seventh', 'middle', 'none'].includes(c.highLat) ? c.highLat : 'angle',
    adjust: Object.fromEntries(PRAYERS.map((k) => [k, Math.round(numIn(c.adjust?.[k], -60, 60, 0))])),
    custom: { fajr: numIn(c.custom?.fajr, 5, 25, 18), isha: numIn(c.custom?.isha, 5, 25, 17), ishaMin: numIn(c.custom?.ishaMin, 0, 180, 0), maghribMin: numIn(c.custom?.maghribMin, 0, 60, 0) },
  };
  const modes = Object.fromEntries(PRAYERS.map((k) => [k, ['athan', 'notify', 'off'].includes(s.modes?.[k]) ? s.modes[k] : 'off']));
  return {
    location: { name: String(l.name || '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 80), lat, lon, tz },
    calc, modes, pre: [0, 5, 10, 15, 20, 30].includes(+s.pre) ? +s.pre : 0, clock: s.clock === '12' ? '12' : '24',
    hijriAdj: [-1, 0, 1].includes(+s.hijriAdj) ? +s.hijriAdj : 0,
  };
}

export async function subId(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(endpoint)));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

const fmtCache = new Map();
export function fmtTime(epoch, tz, clock) {
  const k = tz + clock;
  let f = fmtCache.get(k);
  if (!f) { f = new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: clock === '12' ? 'h12' : 'h23' }); fmtCache.set(k, f); }
  return f.format(epoch);
}
const wdCache = new Map();
function isFriday(epoch, tz) {
  let f = wdCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }); wdCache.set(tz, f); }
  return f.format(epoch) === 'Fri';
}

const hijriCache = new Map();
function hijriMonth(epoch, tz, adj) {
  let f = hijriCache.get(tz);
  if (f === undefined) {
    try { f = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { timeZone: tz, month: 'numeric' }); } catch { f = null; }
    hijriCache.set(tz, f);
  }
  return f ? +f.format(epoch + (adj || 0) * 86400000) : 0;
}

/** Alle Benachrichtigungen, deren Zeitpunkt in (from, to] liegt. */
export function messagesFor(settings, from, to) {
  const { location, calc, modes, pre, clock } = settings;
  let events;
  try { events = upcomingEvents(location, calc, from - 60000, 1); } catch { return []; }
  const out = [];
  for (const e of events) {
    const mode = modes[e.prayer];
    if (!mode || mode === 'off') continue;
    const kind = e.prayer === 'dhuhr' && isFriday(e.at, location.tz) ? 'jumua' : e.prayer;
    const [name, ar] = INFO[kind];
    const when = fmtTime(e.at, location.tz, clock);
    if (e.at > from && e.at <= to) {
      const ramadan = (e.prayer === 'maghrib' || e.prayer === 'fajr') && hijriMonth(e.at, location.tz, settings.hijriAdj) === 9;
      out.push({
        key: `${e.prayer}:${e.at}`, ttl: 900,
        data: {
          title: e.prayer === 'sunrise' ? `Sonnenaufgang (${ar})`
            : ramadan && e.prayer === 'maghrib' ? `Iftar: Zeit für Maghrib (${ar})`
            : ramadan && e.prayer === 'fajr' ? `Suhoor endet: Zeit für Fajr (${ar})` : `Zeit für ${name} (${ar})`,
          body: `${when} · ${location.name}`, tag: `prayer-${e.prayer}-${e.at}`, prayer: e.prayer, at: e.at,
          athan: mode === 'athan' && e.prayer !== 'sunrise', url: './#heute',
        },
      });
    }
    if (pre > 0) {
      const p = e.at - pre * 60000;
      if (p > from && p <= to) {
        out.push({ key: `pre:${e.prayer}:${e.at}`, ttl: pre * 60, data: { title: `${name} in ${pre} Minuten`, body: `Um ${when} · ${location.name}`, tag: `pre-${e.prayer}-${e.at}`, url: './#heute' } });
      }
    }
  }
  return out;
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

export function isAudio(b) {
  if (!b || b.length < 12) return false;
  const t = (a, z) => String.fromCharCode(...b.subarray(a, z));
  return t(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || t(4, 8) === 'ftyp' || t(0, 4) === 'OggS' || t(0, 4) === 'RIFF';
}
