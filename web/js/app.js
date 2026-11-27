import { computeDay, upcomingEvents, zonedParts, addDays, qiblaBearing, distanceToKaabaKm, sunAltitude, METHODS, PRAYERS, suggestMethod, isValidTimeZone } from './praytimes.js';
import { loadLocal, saveLocal, sanitize, DEFAULTS, barkKey } from './store.js';
import { Player, saveCustom, loadCustom } from './audio.js';
import * as plat from './platform.js';
import { moonPosition, moonIllumination, moonLitPath, moonRotation } from './astro.js';
import { specialDay, hijriParts, moonPhaseName } from './hijri.js';
import { initSky } from './sky.js';
import { skyAt } from './palette.js';

const VERSION = '1.3.0';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const INFO = {
  fajr: { name: 'Fajr', ar: 'الفجر', de: 'Morgengebet' },
  sunrise: { name: 'Shuruq', ar: 'الشروق', de: 'Sonnenaufgang' },
  dhuhr: { name: 'Dhuhr', ar: 'الظهر', de: 'Mittagsgebet' },
  asr: { name: 'Asr', ar: 'العصر', de: 'Nachmittagsgebet' },
  maghrib: { name: 'Maghrib', ar: 'المغرب', de: 'Abendgebet' },
  isha: { name: 'Isha', ar: 'العشاء', de: 'Nachtgebet' },
};
const BUILTIN = [
  { id: 'chime', name: 'Sanfter Gong', ar: '', place: 'Ohne Download, funktioniert immer', region: '' },
];

let S = loadLocal();
let voices = [];
let hasCustom = false;
let player;
let lastMinute = -1;
let monthCursor = null;
let desktopState = { playing: null, autostart: false };
const fired = new Set(JSON.parse(sessionStorage.getItem('athan.fired') || '[]'));

// ---------------- Hilfen ----------------
const tz = () => (S.location?.tz && isValidTimeZone(S.location.tz) ? S.location.tz : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
const fmtCache = new Map();
function fmtTime(epoch) {
  if (!isFinite(epoch)) return '—';
  const key = tz() + S.clock;
  let f = fmtCache.get(key);
  if (!f) { f = new Intl.DateTimeFormat('de-DE', { timeZone: tz(), hour: '2-digit', minute: '2-digit', hourCycle: S.clock === '12' ? 'h12' : 'h23' }); fmtCache.set(key, f); }
  return f.format(epoch);
}
const hijriAdj = () => (Number.isInteger(S.hijriAdj) ? S.hijriAdj : 0);
function hijri(epoch, opts, locale = 'de') {
  try { return new Intl.DateTimeFormat(`${locale}-u-ca-islamic-umalqura-nu-latn`, { timeZone: tz(), ...opts }).format(epoch + hijriAdj() * 86400000); } catch { return ''; }
}
const isFriday = (date) => new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay() === 5;
const label = (prayer) => INFO[prayer]; // freitags ebenfalls „Dhuhr“
const voiceById = (id) => voices.find((v) => v.id === id) || BUILTIN.find((v) => v.id === id) || (id === 'custom' ? { id: 'custom', name: 'Eigene Aufnahme' } : null);
function voiceFor(prayer) {
  if (prayer !== 'fajr') return S.voice;
  if (S.fajrVoice && S.fajrVoice !== 'auto') return S.fajrVoice;
  return voiceById(S.voice)?.fajr || S.voice;
}
// „Erste Verse“: bis zur Atempause vor 30 s (aus muezzins.json), eigene Aufnahme 30 s, Gong immer ganz
function athanLimit(id) {
  if (S.athanLength !== 'short' || id === 'chime') return 0;
  const clip = voices.find((x) => x.id === id)?.clip;
  return clip ? clip[1] : 30;
}
const playAthan = (id) => player.play(id, { volume: S.volume, kind: 'athan', limit: athanLimit(id) });
// Ton für Mitteilungen auf dem iPhone (Bark): eigene Aufnahme liegt nur auf dem Gerät → Standardstimme
const soundFor = (prayer) => { const id = voiceFor(prayer); return id === 'custom' ? DEFAULTS.voice : id; };
const pushSettings = () => ({ ...S, sound: { fajr: soundFor('fajr'), other: soundFor('dhuhr') } });

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function hms(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
}

// ---------------- Speichern ----------------
let saveTimer;
function commit(change = {}) {
  S = sanitize({ ...S, ...change });
  saveLocal(S);
  fmtCache.clear();
  lastMinute = -1;
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (plat.isDesktop) { plat.api('/api/settings', { method: 'PUT', body: S }).catch(() => toast('Speichern in der Windows-App fehlgeschlagen')); }
    else if (plat.notifPermission() === 'granted') { plat.syncPush(pushSettings()).then(renderNotifyStatus).catch(() => {}); }
  }, 500);
}

// ---------------- Himmel ----------------
const rgb = (c) => `rgb(${c.join(',')})`;
function paintSky(now, ctx) {
  const root = document.documentElement.style;
  if (!S.location || !ctx) { root.setProperty('--stars', 0.6); return; }
  const alt = sunAltitude(now, S.location.lat, S.location.lon);
  const evening = isFinite(ctx.t.dhuhr) ? now >= ctx.t.dhuhr || now < ctx.t.fajr - 6 * 3600000 : zonedParts(now, tz()).h >= 12;
  const c = skyAt(alt, evening);
  root.setProperty('--sky-top', rgb(c.top));
  root.setProperty('--sky-mid', rgb(c.mid));
  root.setProperty('--sky-low', rgb(c.low));
  root.setProperty('--glow', `rgba(${c.glow.slice(0, 3).map(Math.round).join(',')},${c.glow[3].toFixed(3)})`);
  root.setProperty('--stars', c.stars.toFixed(2));
  // Lichtschein dort, wo die Sonne gerade steht (links morgens, rechts abends)
  const rise = ctx.t.sunrise, set = ctx.t.sunset;
  let fx = evening ? 0.9 : 0.1, fy = 0.34;
  if (isFinite(rise) && isFinite(set) && now >= rise && now <= set) {
    const f = (now - rise) / (set - rise);
    fx = 0.1 + 0.8 * f; fy = 0.32 - 0.2 * Math.sin(Math.PI * f);
  }
  root.setProperty('--glow-x', `${Math.round(fx * 100)}%`);
  root.setProperty('--glow-y', `${Math.round(fy * 100)}%`);
  document.querySelector('meta[name="theme-color"]').content = '#' + c.top.map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------- Heute ----------------
function dayContext(now) {
  const zone = tz();
  const today = zonedParts(now, zone);
  const date = { y: today.y, m: today.m, d: today.d };
  const t = computeDay(date, S.location, S.calc);
  const yest = computeDay(addDays(date, -1), S.location, S.calc);
  const tomo = computeDay(addDays(date, 1), S.location, S.calc);
  const events = upcomingEvents(S.location, S.calc, now - 1, 2);
  const next = events.find((e) => e.at > now);
  let current = null;
  for (const k of PRAYERS) if (isFinite(t[k]) && t[k] <= now) current = k;
  if (!current && isFinite(yest.isha) && now >= yest.isha) current = 'isha-prev';
  return { date, t, yest, tomo, next, current };
}

function arcPos(e, ctx) {
  const { t, yest, tomo } = ctx;
  const rise = t.sunrise, set = t.sunset;
  if (isFinite(rise) && isFinite(set) && e >= rise && e <= set) {
    const f = (e - rise) / (set - rise);
    return { x: 180 - 140 * Math.cos(Math.PI * f), y: 120 - 98 * Math.sin(Math.PI * f), day: true };
  }
  let start, end;
  if (isFinite(set) && e > set) { start = set; end = tomo.sunrise; } else { start = yest.sunset; end = rise; }
  const g = isFinite(start) && isFinite(end) ? Math.min(1, Math.max(0, (e - start) / (end - start))) : 0.5;
  return { x: 180 + 140 * Math.cos(Math.PI * g), y: 120 + 36 * Math.sin(Math.PI * g), day: false };
}

function renderArc(now, ctx) {
  const marks = $('#arcMarks'), orb = $('#orb');
  const nextKey = ctx.next && ctx.next.date.d === ctx.date.d ? ctx.next.prayer : null;
  const placed = [];
  let html = '';
  const order = PRAYERS.filter((k) => isFinite(ctx.t[k]));
  const prio = [...order].sort((a, b) => (b === nextKey) - (a === nextKey));
  const labelled = new Set();
  for (const k of prio) {
    const p = arcPos(ctx.t[k], ctx);
    if (placed.every((q) => Math.abs(q - p.x) > 34)) { labelled.add(k); placed.push(p.x); }
  }
  for (const k of order) {
    const p = arcPos(ctx.t[k], ctx);
    const cls = k === nextKey ? 'next' : ctx.t[k] <= now ? 'passed' : '';
    html += `<circle class="mark ${cls}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${k === nextKey ? 5 : 3.6}"/>`;
    if (labelled.has(k)) {
      const ly = p.day ? p.y - 11 : p.y + 17;
      html += `<text class="mark-label ${cls}" x="${p.x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${esc(label(k, ctx.date).name)}</text>`;
    }
  }
  marks.innerHTML = html;
  const o = arcPos(now, ctx);
  orb.innerHTML = o.day
    ? `<circle cx="${o.x}" cy="${o.y}" r="22" fill="url(#sunGlow)"/><circle cx="${o.x}" cy="${o.y}" r="6.5" fill="#FFE3A0"/>`
    : `<circle cx="${o.x.toFixed(1)}" cy="${o.y.toFixed(1)}" r="4" class="sun-below"><title>Sonne unter dem Horizont</title></circle>`;
  renderMoon(now, o.day);
  const done = $('#dayDone');
  if (isFinite(ctx.t.sunrise) && now > ctx.t.sunrise) {
    const p = now >= ctx.t.sunset ? { x: 320, y: 120 } : o;
    done.setAttribute('d', `M40 120 A140 98 0 0 1 ${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
  } else done.setAttribute('d', '');
  $('#hzRise').textContent = fmtTime(ctx.t.sunrise);
  $('#hzSet').textContent = fmtTime(ctx.t.sunset);
}

// Mond am Himmel: Position nach Azimut/Höhe am Ort, Phase und Lage der hellen Seite echt berechnet
function renderMoon(now, isDay) {
  const g = $('#moonG');
  const { lat, lon } = S.location;
  const pos = moonPosition(now, lat, lon);
  if (pos.altitude < -2) { g.innerHTML = ''; return; }
  const ill = moonIllumination(now);
  const az = (pos.azimuth * Math.PI) / 180, alt = (Math.max(0, pos.altitude) * Math.PI) / 180;
  const x = 180 + 140 * Math.sin(az), y = 118 - 96 * Math.sin(alt);
  const r = 9, rot = moonRotation(now, lat, lon);
  const pct = Math.round(ill.fraction * 100);
  g.style.opacity = isDay ? '0.55' : '1';
  g.innerHTML = `<title>Mond: ${moonPhaseName(ill.phase)}, ${pct} % beleuchtet</title>
    <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(16 + 14 * ill.fraction).toFixed(1)}" fill="url(#moonHalo)" opacity="${(0.35 + 0.65 * ill.fraction).toFixed(2)}"/>
    <g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(1)})">
      ${isDay ? '' : `<circle r="${r}" class="moon-dark"/>`}
      <path d="${moonLitPath(ill.fraction, r)}" class="moon-lit"/>
    </g>`;
}

const MODE_ICON = { athan: 'i-athan', notify: 'i-notify', off: 'i-off' };
const MODE_TEXT = { athan: 'Athan', notify: 'Nur Hinweis', off: 'Aus' };

function renderList(now, ctx) {
  const { t, next, current, date } = ctx;
  $('#times').innerHTML = PRAYERS.map((k) => {
    const L = label(k, date);
    const cls = [t[k] <= now ? 'passed' : '', current === k ? 'current' : '', next && next.prayer === k && next.date.d === date.d ? 'next' : ''].join(' ');
    const mode = S.modes[k];
    return `<li class="time-row ${cls}">
      <div class="t-names"><span class="t-name">${esc(L.name)}</span><span class="t-ar" lang="ar">${L.ar}</span><span class="t-de">${esc(L.de)}</span></div>
      <span class="t-time">${fmtTime(t[k])}</span>
      <button class="t-mode" type="button" data-prayer="${k}" data-mode="${mode}" aria-label="${esc(L.name)}: ${MODE_TEXT[mode]}. Tippen zum Ändern" title="${MODE_TEXT[mode]}"><svg><use href="#${MODE_ICON[mode]}"/></svg></button>
    </li>`;
  }).join('');
  const ill = moonIllumination(now);
  $('#extras').innerHTML = [['Imsak', fmtTime(t.imsak)], ['Mitternacht', fmtTime(t.midnight)], ['Qiyam', fmtTime(t.lastThird), 'Qiyam al-Layl: Beginn des letzten Drittels der Nacht'], ['Mond', `${Math.round(ill.fraction * 100)} %`, moonPhaseName(ill.phase)]]
    .map(([n, v, title]) => `<div${title ? ` title="${esc(title)}"` : ''}><dt>${esc(n)}</dt><dd>${esc(v)}</dd></div>`).join('');
  const m = METHODS[S.calc.method] || METHODS.MWL;
  $('#methodNote').textContent = `${m.name}, Asr ${S.calc.asr === 'hanafi' ? 'Hanafi' : 'Standard'}. Zeiten in ${tz().replace(/_/g, ' ')}.`;
}

function renderHeader(now) {
  $('#placeName').textContent = S.location ? S.location.name : 'Ort wählen';
  const ha = $('#hijriAr');
  ha.textContent = hijri(now, { day: 'numeric', month: 'long', year: 'numeric' }, 'ar');
  ha.title = hijri(now, { day: 'numeric', month: 'long', year: 'numeric' });
  $('#gregDate').textContent = new Intl.DateTimeFormat('de-DE', { timeZone: tz(), weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
}

function renderToday(now) {
  renderHeader(now);
  $('#onboard').hidden = !!S.location;
  $('#arc').hidden = !S.location;
  if (!S.location) {
    $('#nextLabel').textContent = 'Willkommen';
    $('#nextName').textContent = 'Wo betest du?';
    $('#nextAr').textContent = '';
    $('#countdown').textContent = '';
    $('#nextAt').textContent = 'Wähle deinen Ort, dann berechnet Athan die Gebetszeiten.';
    $('#times').innerHTML = ''; $('#extras').innerHTML = ''; $('#methodNote').textContent = '';
    $('#arcMarks').innerHTML = ''; $('#orb').innerHTML = ''; $('#moonG').innerHTML = '';
    $('#dayChip').hidden = true; $('#ramadanBar').hidden = true; $('#lanterns').hidden = true;
    renderPrompts();
    return null;
  }
  const ctx = dayContext(now);
  const minute = Math.floor(now / 60000);
  if (minute !== lastMinute) { lastMinute = minute; renderArc(now, ctx); renderList(now, ctx); paintSky(now, ctx); renderPrompts(); renderSeason(now, ctx); }
  if (ctx.next) {
    const L = label(ctx.next.prayer, ctx.next.date);
    const ramadanNext = hijriParts(ctx.next.at, tz(), hijriAdj()).m === 9;
    $('#nextLabel').textContent = ctx.next.prayer === 'sunrise' ? 'Die Fajr-Zeit endet mit'
      : ramadanNext && ctx.next.prayer === 'maghrib' ? 'Iftar mit' : ramadanNext && ctx.next.prayer === 'fajr' ? 'Suhoor endet mit' : 'Nächstes Gebet';
    $('#nextName').textContent = L.name;
    $('#nextAr').textContent = L.ar;
    const left = ctx.next.at - now;
    $('#countdown').textContent = hms(left);
    const tomorrow = ctx.next.date.d !== ctx.date.d;
    $('#nextAt').textContent = `${tomorrow ? 'Morgen um' : 'Um'} ${fmtTime(ctx.next.at)}`;
    document.title = `${L.name} in ${hms(left).slice(0, -3)} – Athan`;
  }
  return ctx;
}

// Ramadan, Eid und besondere Tage
function renderSeason(now, ctx) {
  const sp = specialDay(now, tz(), hijriAdj());
  const chip = $('#dayChip');
  chip.hidden = !sp;
  chip.classList.toggle('eid', sp?.kind === 'eid');
  if (sp) { $('#dayChipText').textContent = sp.de; $('#dayChipAr').textContent = sp.ar; }
  const ramadan = sp?.kind === 'ramadan';
  $('#ramadanBar').hidden = !ramadan;
  $('#lanterns').hidden = !(ramadan || sp?.kind === 'eid');
  if (ramadan) {
    const suhoor = now < ctx.t.fajr ? ctx.t.fajr : ctx.tomo.fajr;
    $('#suhoorT').textContent = fmtTime(suhoor);
    $('#iftarT').textContent = fmtTime(ctx.t.maghrib);
  }
}

// ---------------- Athan auslösen (Web-Modus) ----------------
function remember(key) {
  fired.add(key);
  sessionStorage.setItem('athan.fired', JSON.stringify([...fired].slice(-40)));
}
function checkSchedule(now) {
  if (plat.isDesktop || !S.location) return;
  const ev = upcomingEvents(S.location, S.calc, now - 120000, 1);
  for (const e of ev) {
    const key = `${e.prayer}:${e.at}`;
    const mode = S.modes[e.prayer];
    if (mode !== 'off' && e.at <= now && now - e.at < 90000 && !fired.has(key)) { remember(key); fire(e); }
    if (S.pre > 0 && mode !== 'off') {
      const preAt = e.at - S.pre * 60000, pkey = 'pre:' + key;
      if (preAt <= now && now - preAt < 90000 && !fired.has(pkey)) {
        remember(pkey);
        const L = label(e.prayer, e.date);
        plat.showNotification(`${L.name} in ${S.pre} Minuten`, { body: `Um ${fmtTime(e.at)} · ${S.location.name}`, tag: 'pre-' + key });
      }
    }
  }
}
async function fire(e) {
  const L = label(e.prayer, e.date);
  const mode = e.test ? 'athan' : S.modes[e.prayer];
  const inRamadan = hijriParts(e.at, tz(), hijriAdj()).m === 9;
  const title = e.test ? 'Athan – Test' : e.prayer === 'sunrise' ? `Sonnenaufgang (${L.ar})`
    : inRamadan && e.prayer === 'maghrib' ? `Iftar: Zeit für Maghrib (${L.ar})`
    : inRamadan && e.prayer === 'fajr' ? `Suhoor endet: Zeit für Fajr (${L.ar})` : `Zeit für ${L.name} (${L.ar})`;
  plat.showNotification(title, {
    body: `${fmtTime(e.at)} · ${S.location.name}`, tag: e.test ? 'athan-test' : `prayer-${e.prayer}-${e.at}`, requireInteraction: mode === 'athan' && !e.test,
  });
  if (mode === 'athan' && e.prayer !== 'sunrise') {
    player.stop();
    showOverlay(e.prayer, e.date, voiceFor(e.prayer));
    try { await playAthan(voiceFor(e.prayer)); }
    catch { setPending(e.prayer); }
  }
}

// Wiedergabe wurde vom Browser blockiert (z. B. iPhone nach Tippen auf die Benachrichtigung)
let pendingPrayer = null;
function setPending(prayer) {
  pendingPrayer = prayer;
  $('#ovStop').innerHTML = '<svg><use href="#i-play"/></svg>Athan abspielen';
}
function clearPending() {
  pendingPrayer = null;
  $('#ovStop').innerHTML = '<svg><use href="#i-stop"/></svg>Athan stoppen';
}

function showOverlay(prayer, date, voiceId) {
  const L = label(prayer, date);
  $('#ovName').textContent = L.name;
  $('#ovAr').textContent = L.ar;
  const v = voiceById(voiceId);
  $('#ovVoice').textContent = v ? [v.name, v.place].filter(Boolean).join(', ') : '';
  $('#athanOverlay').hidden = false;
  $('#ovStop').focus();
}
function hideOverlay() { $('#athanOverlay').hidden = true; clearPending(); }

// ---------------- Hinweise ----------------
function renderPrompts() {
  const ios = $('#iosPrompt'), en = $('#enablePrompt');
  if (plat.isDesktop || !S.location) { ios.hidden = en.hidden = true; return; }
  const iosNeedsInstall = plat.isIOS && !plat.isStandalone && !localStorage.getItem('athan.iosHint');
  ios.hidden = !iosNeedsInstall;
  en.hidden = iosNeedsInstall || !plat.notifSupported() || plat.notifPermission() !== 'default';
}
async function enableAll() {
  await player.unlock();
  const p = await plat.requestNotifications();
  if (p === 'granted') {
    toast('Benachrichtigungen sind aktiv');
    try { await plat.syncPush(pushSettings()); } catch {}
  } else if (p === 'denied') toast('Benachrichtigungen wurden blockiert');
  renderPrompts(); renderNotifyStatus();
}

// ---------------- Qibla ----------------
const qiblaVisible = () => !document.querySelector('[data-view="qibla"]').hidden && !document.hidden;
function buildDial() {
  let t = '';
  for (let a = 0; a < 360; a += 5) {
    const major = a % 30 === 0, r1 = 150, r2 = major ? 136 : 143;
    const s = Math.sin((a * Math.PI) / 180), c = -Math.cos((a * Math.PI) / 180);
    t += `<line class="tick ${major ? 'major' : ''}" x1="${160 + r1 * s}" y1="${160 + r1 * c}" x2="${160 + r2 * s}" y2="${160 + r2 * c}"/>`;
  }
  $('#ticks').innerHTML = t;
}
function renderQibla() {
  if (!S.location) { $('#qiblaPlace').textContent = 'Wähle zuerst einen Ort.'; return; }
  const b = qiblaBearing(S.location.lat, S.location.lon);
  const km = distanceToKaabaKm(S.location.lat, S.location.lon);
  $('#qiblaPlace').textContent = `Von ${S.location.name} zur Kaaba in Mekka`;
  $('#qiblaDeg').textContent = b.toLocaleString('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  $('#qiblaDist').textContent = `${Math.round(km).toLocaleString('de-DE')} km Luftlinie`;
  $('#qiblaSub').textContent = `von Norden im Uhrzeigersinn, Richtung ${WINDS[Math.round(b / 22.5) % 16]}`;
  const rad = (b * Math.PI) / 180, s = Math.sin(rad), c = -Math.cos(rad);
  const x = 160 + 104 * s, y = 160 + 104 * c;
  $('#qiblaPointer').innerHTML = `
    <line class="qp-line" x1="160" y1="160" x2="${x}" y2="${y}"/>
    <circle cx="160" cy="160" r="5" fill="#D8B26E"/>
    <g transform="translate(${x} ${y}) rotate(${b})">
      <rect class="qp-kaaba" x="-12" y="-12" width="24" height="24" rx="2"/>
      <line class="qp-band" x1="-12" y1="-4.5" x2="12" y2="-4.5"/>
    </g>`;
  Compass.update();
}

const WINDS = ['Nord', 'Nordnordost', 'Nordost', 'Ostnordost', 'Ost', 'Ostsüdost', 'Südost', 'Südsüdost', 'Süd', 'Südsüdwest', 'Südwest', 'Westsüdwest', 'West', 'Westnordwest', 'Nordwest', 'Nordnordwest'];

// Kompass startet von selbst. Das iPhone verlangt einmalig eine Erlaubnis – sie wird beim Tippen
// auf „Qibla“ angefragt (dafür braucht iOS eine Berührung).
const Compass = {
  // Erlaubnis nur auf Handys/Tablets nötig (Touch); ein PC hat keinen Kompass
  needsPerm: typeof window.DeviceOrientationEvent?.requestPermission === 'function' && navigator.maxTouchPoints > 0,
  noSensor: plat.isDesktop && navigator.maxTouchPoints === 0,
  listening: false, got: false, denied: false, smooth: null, heading: null, acc: null, rot: 0, buzz: false, timer: 0,
  listen() {
    if (this.listening || !window.DeviceOrientationEvent) return;
    this.listening = true;
    const scr = () => (screen.orientation?.angle ?? window.orientation ?? 0);
    window.addEventListener('deviceorientation', (e) => {
      if (typeof e.webkitCompassHeading === 'number') this.onHeading(e.webkitCompassHeading + scr(), e.webkitCompassAccuracy);
      else if (e.absolute && e.alpha != null) this.onHeading(360 - e.alpha + scr(), null); // Firefox
    }, true);
    window.addEventListener('deviceorientationabsolute', (e) => { if (e.alpha != null) this.onHeading(360 - e.alpha + scr(), null); }, true);
  },
  request() {
    if (!this.needsPerm || this.got) { this.listen(); return; }
    try {
      DeviceOrientationEvent.requestPermission().then((r) => {
        this.denied = r !== 'granted';
        if (!this.denied) { localStorage.setItem('athan.motion', '1'); this.listen(); }
        this.status();
      }).catch(() => this.status());
    } catch { this.status(); }
  },
  onShow() {
    this.listen();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.status(false), 1500);
    this.status(true);
  },
  onHeading(h, acc) {
    if (h == null || isNaN(h) || !qiblaVisible()) return;
    const first = !this.got;
    this.got = true; this.acc = acc;
    const r = (h * Math.PI) / 180;
    this.smooth = this.smooth ? { x: this.smooth.x * 0.82 + Math.cos(r) * 0.18, y: this.smooth.y * 0.82 + Math.sin(r) * 0.18 } : { x: Math.cos(r), y: Math.sin(r) };
    this.heading = ((Math.atan2(this.smooth.y, this.smooth.x) * 180) / Math.PI + 360) % 360;
    if (first) this.status();
    this.update();
  },
  update() {
    const dial = $('#dial');
    if (this.heading == null) { dial.style.transform = ''; $('#compass').classList.remove('aligned'); return; }
    // kürzesten Weg drehen – kein Herumwirbeln beim Übergang 359° → 0°
    const delta = ((((-this.heading - this.rot) % 360) + 540) % 360) - 180;
    this.rot += delta;
    dial.style.transform = `rotate(${this.rot}deg)`;
    if (!S.location) return;
    const diff = ((qiblaBearing(S.location.lat, S.location.lon) - this.heading + 540) % 360) - 180;
    const aligned = Math.abs(diff) < 4;
    $('#compass').classList.toggle('aligned', aligned);
    $('#qiblaStatus').textContent = aligned ? 'Du schaust in Richtung Qibla' : diff > 0 ? `Dreh dich ${Math.round(diff)}° nach rechts` : `Dreh dich ${Math.round(-diff)}° nach links`;
    $('#compassHint').textContent = this.acc != null && (this.acc < 0 || this.acc > 25)
      ? 'Der Kompass ist ungenau: Bewege das Handy einmal in Form einer Acht.'
      : 'Halte das Handy flach vor dich.';
    if (aligned && !this.buzz) { navigator.vibrate?.(60); this.buzz = true; }
    if (!aligned) this.buzz = false;
  },
  status(initial = false) {
    const btn = $('#compassBtn'), st = $('#qiblaStatus');
    if (this.got) { btn.hidden = true; return; }
    if (this.noSensor) { btn.hidden = true; st.textContent = 'Dein Computer hat keinen Kompass. Richte dich nach der Gradzahl oder der Himmelsrichtung.'; return; }
    if (initial && !this.denied) { btn.hidden = true; st.textContent = 'Kompass wird gesucht …'; return; }
    if (this.needsPerm) {
      btn.hidden = false;
      st.textContent = this.denied ? 'Kompass nicht erlaubt. Schließe Athan ganz, öffne es neu und tippe auf „Erlauben“.' : 'Tippe auf „Kompass einschalten“.';
      return;
    }
    btn.hidden = true;
    st.textContent = 'Kein Kompass auf diesem Gerät. Richte dich nach der Gradzahl.';
  },
};

// ---------------- Monat ----------------
function renderMonth() {
  if (!S.location) { $('#month-title').textContent = 'Monat'; $('#monthTable').innerHTML = ''; $('#monthPlace').textContent = 'Wähle zuerst einen Ort.'; return; }
  const now = Date.now();
  const today = zonedParts(now, tz());
  if (!monthCursor) monthCursor = { y: today.y, m: today.m };
  const { y, m } = monthCursor;
  $('#month-title').textContent = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, 15));
  $('#monthPlace').textContent = `${S.location.name}, ${(METHODS[S.calc.method] || METHODS.MWL).name}`;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const wd = new Intl.DateTimeFormat('de-DE', { weekday: 'short', timeZone: 'UTC' });
  const hd = (d) => { try { return new Intl.DateTimeFormat('de-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, d, 12) + hijriAdj() * 86400000); } catch { return ''; } };
  let rows = '';
  for (let d = 1; d <= days; d++) {
    const t = computeDay({ y, m, d }, S.location, S.calc);
    const isToday = today.y === y && today.m === m && today.d === d;
    const fri = isFriday({ y, m, d });
    rows += `<tr class="${isToday ? 'today' : ''} ${fri ? 'fri' : ''}"><td>${wd.format(Date.UTC(y, m - 1, d, 12)).replace('.', '')} ${d}.<span class="hd">${esc(hd(d))}</span></td>${PRAYERS.map((k) => `<td>${fmtTime(t[k])}</td>`).join('')}</tr>`;
  }
  $('#monthTable').innerHTML = `<thead><tr><th scope="col">Tag</th>${PRAYERS.map((k) => `<th scope="col">${INFO[k].name}</th>`).join('')}</tr></thead><tbody>${rows}</tbody>`;
}

// ---------------- Einstellungen ----------------
function renderSettings() {
  const l = S.location;
  $('#currentLoc').innerHTML = l
    ? `<b>${esc(l.name)}</b><small>${esc([l.region, l.country].filter(Boolean).join(', '))}${l.region || l.country ? '. ' : ''}${l.lat.toFixed(4)}, ${l.lon.toFixed(4)}, ${esc(l.tz)}</small>`
    : '<small>Noch kein Ort gewählt.</small>';

  // Stimmen
  const list = [...voices.filter((v) => !v.fajrOnly), ...BUILTIN, ...(hasCustom ? [{ id: 'custom', name: 'Eigene Aufnahme', place: 'Von diesem Gerät', region: '' }] : [])];
  $('#voices').innerHTML = list.map((v) => `
    <div class="voice">
      <input type="radio" name="voice" id="v-${v.id}" value="${v.id}" ${S.voice === v.id ? 'checked' : ''}>
      <label class="voice-text" for="v-${v.id}"><b>${esc(v.name)}${v.ar ? `<span class="voice-ar" lang="ar">${v.ar}</span>` : ''}</b><small>${esc([v.place, v.region && !String(v.place).includes(v.region) ? v.region : ''].filter(Boolean).join(', '))}</small></label>
      <button class="icon-btn preview ${player?.current?.id === v.id ? 'playing' : ''}" type="button" data-voice="${v.id}" aria-label="${esc(v.name)} anhören"><svg><use href="#${player?.current?.id === v.id ? 'i-stop' : 'i-play'}"/></svg></button>
    </div>`).join('');

  const fv = $('#fajrVoice');
  const fajrOpts = [['auto', 'Passend zur Stimme'], ...voices.filter((v) => v.fajrOnly).map((v) => [v.id, v.name]), ...voices.filter((v) => !v.fajrOnly).map((v) => [v.id, v.name]), ['chime', 'Sanfter Gong'], ...(hasCustom ? [['custom', 'Eigene Aufnahme']] : [])];
  fv.innerHTML = fajrOpts.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('');
  fv.value = S.fajrVoice;
  $('#volume').value = S.volume;
  $('#preReminder').value = String(S.pre);

  $('#modes').innerHTML = PRAYERS.map((k) => `
    <div class="mode-row"><span class="m-name">${INFO[k].name}</span>
      <div class="seg" role="radiogroup" aria-label="${INFO[k].name}">
        ${['athan', 'notify', 'off'].filter((m) => !(k === 'sunrise' && m === 'athan')).map((m) => `<label><input type="radio" name="mode-${k}" value="${m}" ${S.modes[k] === m ? 'checked' : ''}><span>${MODE_TEXT[m]}</span></label>`).join('')}
      </div></div>`).join('');

  // Berechnung
  const sug = l ? suggestMethod(l.cc).method : null;
  $('#method').innerHTML = Object.entries(METHODS).map(([id, m]) => `<option value="${id}">${esc(m.name)}${id === sug ? ' (empfohlen)' : ''}</option>`).join('');
  $('#method').value = S.calc.method;
  $('#customAngles').hidden = S.calc.method !== 'Custom';
  $('#cFajr').value = S.calc.custom.fajr; $('#cIsha').value = S.calc.custom.isha; $('#cIshaMin').value = S.calc.custom.ishaMin;
  $$('input[name="asr"]').forEach((r) => (r.checked = r.value === S.calc.asr));
  $('#highLat').value = S.calc.highLat;
  $('#adjustGrid').innerHTML = PRAYERS.map((k) => `<label>${INFO[k].name}<input type="number" min="-60" max="60" step="1" data-adj="${k}" value="${S.calc.adjust[k]}"></label>`).join('');
  $$('input[name="clock"]').forEach((r) => (r.checked = r.value === S.clock));
  $$('input[name="athanLength"]').forEach((r) => (r.checked = r.value === S.athanLength));
  $('#hijriAdj').value = String(hijriAdj());
  renderIphone();

  $$('.desktop-only').forEach((e) => (e.hidden = !plat.isDesktop));
  $('#autostart').checked = !!desktopState.autostart;
  $('#openOnAthan').checked = !!S.openOnAthan;
  $('#versionLine').textContent = `Version ${VERSION}${plat.isDesktop ? ' für Windows' : plat.isStandalone ? ' (installiert)' : ''}`;
  renderNotifyStatus();
}

// ---------------- iPhone: Bark & Widget ----------------
async function renderIphone() {
  const show = plat.isIOS && !plat.isDesktop;
  $('#iphoneGroup').hidden = !show;
  if (!show) return;
  loadWidgetTemplate();
  const key = S.bark.key, st = $('#barkStatus'), input = $('#barkKey');
  if (document.activeElement !== input) input.value = key ? `https://api.day.app/${key}/` : '';
  $('#barkCritical').checked = S.bark.critical;
  $('#barkActions').hidden = !key;
  st.classList.remove('warn');
  if (!key) { st.innerHTML = 'Noch nicht eingerichtet. Ohne Bark kommt die Mitteilung mit dem normalen Ton.'; return; }
  const info = await plat.detectServer();
  if (!info?.push) { st.innerHTML = '<b>Nicht möglich.</b> Öffne Athan über deine Cloudflare-Adresse.'; st.classList.add('warn'); return; }
  if (plat.notifPermission() !== 'granted') { st.innerHTML = '<b>Fast fertig.</b> Erlaube oben noch die Benachrichtigungen.'; st.classList.add('warn'); return; }
  st.innerHTML = `<b>Aktiv.</b> Zu jeder Gebetszeit spielt das iPhone die ersten Verse des Athan, auch gesperrt${S.bark.critical ? ' und lautlos' : ''}.`;
}

async function saveBark() {
  const key = barkKey($('#barkKey').value);
  if (!key) { toast('Das ist kein Bark-Link. Kopiere ihn in Bark (beginnt mit https://api.day.app/).', 5000); return; }
  if (plat.notifPermission() !== 'granted') { await enableAll(); if (plat.notifPermission() !== 'granted') return; }
  commit({ bark: { key, critical: $('#barkCritical').checked } });
  $('#barkKey').blur();
  await barkTest(true);
}
async function barkTest(saved = false) {
  try {
    const r = await plat.syncPush(pushSettings());
    if (!r?.ok) throw new Error(r?.reason);
    const t = await plat.testPush(0);
    if (!t) { toast('Bitte 10 Sekunden warten und noch einmal testen.', 4000); return; }
    toast(t.via === 'bark' ? `${saved ? 'Gespeichert. ' : ''}Gleich klingt der Athan über Bark.` : 'Bark hat nicht geantwortet. Prüfe den Link in Bark.', 6000);
  } catch { toast('Erst Benachrichtigungen erlauben (Athan über die Cloudflare-Adresse öffnen).', 6000); }
  renderIphone();
}

// Widget-Code (Scriptable): Vorlage vorab laden, damit das Kopieren direkt im Tippen passiert (iOS verlangt das)
let widgetTpl = null;
async function loadWidgetTemplate() {
  if (widgetTpl) return widgetTpl;
  try { const r = await fetch('widget/athan-widget.js'); if (r.ok) widgetTpl = await r.text(); } catch {}
  return widgetTpl;
}
function widgetCode() {
  const l = S.location;
  const cfg = { name: l.name, lat: l.lat, lon: l.lon, tz: tz(), calc: S.calc, clock: S.clock, hijriAdj: hijriAdj() };
  return widgetTpl.replace(/\/\*CONFIG\*\/[\s\S]*?\/\*END\*\//, () => `/*CONFIG*/${JSON.stringify(cfg)}/*END*/`);
}
async function copyWidget() {
  if (!S.location) { toast('Wähle zuerst einen Ort'); return; }
  const done = () => toast('Kopiert. Jetzt in Scriptable einfügen.', 4000);
  if (!widgetTpl && window.ClipboardItem && navigator.clipboard?.write) {
    try { // Safari erlaubt hier nachgeladenen Inhalt
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': loadWidgetTemplate().then(() => new Blob([widgetCode()], { type: 'text/plain' })) })]);
      return done();
    } catch { /* weiter unten */ }
  }
  if (!(await loadWidgetTemplate())) { toast('Widget-Code nicht erreichbar. Prüfe die Internetverbindung.'); return; }
  const code = widgetCode();
  try { await navigator.clipboard.writeText(code); done(); }
  catch {
    const ta = $('#widgetCode'); ta.value = code; ta.hidden = false; ta.focus(); ta.select();
    toast('Code ist markiert: tippe auf „Kopieren“.', 5000);
  }
}

async function renderNotifyStatus() {
  const el = $('#notifyStatus'), en = $('#notifyEnable');
  el.classList.remove('warn');
  if (plat.isDesktop) {
    el.innerHTML = '<b>Aktiv.</b> Athan und Windows-Benachrichtigungen laufen im Hintergrund, solange Athan im Infobereich der Taskleiste aktiv ist.';
    en.hidden = true; return;
  }
  const perm = plat.notifPermission();
  if (plat.isIOS && !plat.isStandalone) {
    el.innerHTML = '<b>Noch nicht möglich.</b> Auf dem iPhone funktionieren Benachrichtigungen nur, wenn du Athan über Teilen → Zum Home-Bildschirm installierst.';
    el.classList.add('warn'); en.hidden = true; return;
  }
  en.hidden = perm === 'granted' || perm === 'unsupported';
  if (perm === 'unsupported') { el.innerHTML = '<b>Nicht unterstützt.</b> Dieser Browser kann keine Benachrichtigungen anzeigen.'; el.classList.add('warn'); return; }
  if (perm === 'denied') { el.innerHTML = '<b>Blockiert.</b> Erlaube Benachrichtigungen für diese Seite in den Browser- bzw. Systemeinstellungen.'; el.classList.add('warn'); return; }
  if (perm === 'default') { el.innerHTML = 'Noch nicht erlaubt.'; return; }
  const info = await plat.detectServer();
  const sub = await plat.currentPushSubscription().catch(() => null);
  $('#pushTest').hidden = !(info?.push && sub);
  if (info?.push && sub) {
    el.innerHTML = '<b>Aktiv, auch bei geschlossener App.</b> Du bekommst zu jeder Gebetszeit eine Mitteilung.'
      + (!plat.isIOS ? '' : S.bark.key ? ' Den Athan-Ton spielt Bark.' : ' Für den Athan-Ton bei gesperrtem iPhone richte unten „iPhone“ ein.');
  }
  else if (info?.push) el.innerHTML = '<b>Erlaubt.</b> Die Mitteilungen werden gerade eingerichtet …';
  else el.innerHTML = '<b>Aktiv, solange die App geöffnet ist.</b> Für Mitteilungen bei geschlossener App öffne Athan über deine Cloudflare-Adresse.';
}

// Ortssuche (Open-Meteo, ohne Schlüssel)
let searchTimer, searchSeq = 0;
async function searchCity(q) {
  const ul = $('#cityResults');
  if (q.trim().length < 2) { ul.innerHTML = ''; return; }
  const seq = ++searchSeq;
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q.trim())}&count=8&language=de&format=json`);
    const j = await r.json();
    if (seq !== searchSeq) return;
    const res = j.results || [];
    ul.innerHTML = res.length ? res.map((c, i) => `<li><button type="button" data-i="${i}"><b>${esc(c.name)}</b> <small>${esc([c.admin1, c.country].filter(Boolean).join(', '))}</small></button></li>`).join('') : '<li class="empty">Kein Ort gefunden. Prüfe die Schreibweise oder gib Koordinaten ein.</li>';
    $$('button', ul).forEach((b) => (b.onclick = () => {
      const c = res[+b.dataset.i];
      setLocation({ name: c.name, region: c.admin1 || '', country: c.country || '', cc: c.country_code || '', lat: c.latitude, lon: c.longitude, tz: c.timezone || 'UTC' });
      ul.innerHTML = ''; $('#citySearch').value = '';
    }));
  } catch {
    if (seq === searchSeq) ul.innerHTML = '<li class="empty">Ortssuche nicht erreichbar. Prüfe die Internetverbindung oder gib Koordinaten ein.</li>';
  }
}
function setLocation(loc) {
  const change = { location: loc };
  if (S.methodAuto) { const s = suggestMethod(loc.cc); change.calc = { ...S.calc, method: s.method, asr: s.asr }; }
  commit(change);
  toast(`Ort gespeichert: ${loc.name}`);
  location.hash = '#heute';
}
async function useGPS() {
  if (!navigator.geolocation) { toast('Standort wird von diesem Gerät nicht unterstützt'); return; }
  toast('Standort wird ermittelt …', 8000);
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const lat = +pos.coords.latitude.toFixed(5), lon = +pos.coords.longitude.toFixed(5);
    const devTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    let name = 'Mein Standort', region = '', country = '', cc = '';
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&accept-language=de`);
      const j = await r.json(); const a = j.address || {};
      name = a.city || a.town || a.village || a.municipality || a.county || name;
      region = a.state || ''; country = a.country || ''; cc = (a.country_code || '').toUpperCase();
    } catch {}
    setLocation({ name, region, country, cc, lat, lon, tz: devTz });
  }, (err) => toast(err.code === 1 ? 'Standortzugriff wurde abgelehnt' : 'Standort konnte nicht ermittelt werden'), { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
}

function goPickPlace() { location.hash = '#einstellungen'; setTimeout(() => $('#citySearch').focus(), 50); }

// ---------------- Routing ----------------
function route() {
  const tab = (location.hash || '#heute').slice(1);
  const valid = ['heute', 'qibla', 'monat', 'einstellungen'].includes(tab) ? tab : 'heute';
  $$('[data-view]').forEach((v) => (v.hidden = v.dataset.view !== valid));
  $$('.nav [data-tab]').forEach((a) => (a.dataset.tab === valid ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (valid === 'qibla') { renderQibla(); Compass.onShow(); }
  if (valid === 'monat') renderMonth();
  if (valid === 'einstellungen') renderSettings();
  window.scrollTo(0, 0);
}
function render() {
  lastMinute = -1;
  renderToday(Date.now());
  const tab = (location.hash || '#heute').slice(1);
  if (tab === 'qibla') renderQibla();
  if (tab === 'monat') renderMonth();
  if (tab === 'einstellungen') renderSettings();
}

// ---------------- Ereignisse ----------------
function bind() {
  window.addEventListener('hashchange', route);
  $('#placeBtn').onclick = goPickPlace;
  $('#enableBtn').onclick = enableAll;
  $('#iosDismiss').onclick = () => { localStorage.setItem('athan.iosHint', '1'); renderPrompts(); };
  $('#ovStop').onclick = async () => {
    if (pendingPrayer) {
      const p = pendingPrayer; clearPending();
      try { await playAthan(voiceFor(p)); } catch { setPending(p); }
      return;
    }
    player.stop(); hideOverlay(); if (plat.isDesktop) plat.api('/api/stop', { method: 'POST' }).catch(() => {});
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#athanOverlay').hidden) $('#ovStop').click(); });

  $('#times').addEventListener('click', (e) => {
    const b = e.target.closest('.t-mode'); if (!b) return;
    const k = b.dataset.prayer;
    const cycle = k === 'sunrise' ? ['notify', 'off'] : ['athan', 'notify', 'off'];
    const next = cycle[(cycle.indexOf(S.modes[k]) + 1) % cycle.length];
    commit({ modes: { ...S.modes, [k]: next } });
    toast(`${INFO[k].name}: ${MODE_TEXT[next]}`);
  });

  // Qibla: Erlaubnis direkt beim Tippen auf den Reiter (iOS braucht dafür eine Berührung)
  buildDial();
  $('.nav [data-tab="qibla"]').addEventListener('click', () => Compass.request());
  $('#compassBtn').onclick = () => Compass.request();
  $('#compass').addEventListener('click', () => Compass.request());

  // Einrichtung
  $('#obGps').onclick = useGPS;
  $('#obSearch').onclick = goPickPlace;

  // Monat
  $('#prevMonth').onclick = () => { const d = new Date(Date.UTC(monthCursor.y, monthCursor.m - 2, 1)); monthCursor = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; renderMonth(); };
  $('#nextMonth').onclick = () => { const d = new Date(Date.UTC(monthCursor.y, monthCursor.m, 1)); monthCursor = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; renderMonth(); };
  $('#printBtn').onclick = () => window.print();

  // Einstellungen
  $('#citySearch').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => searchCity(e.target.value), 300); });
  $('#citySearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); searchCity(e.target.value); } });
  $('#gpsBtn').onclick = useGPS;
  const zones = [...new Set([...(Intl.supportedValuesOf?.('timeZone') || [Intl.DateTimeFormat().resolvedOptions().timeZone]), 'UTC'])].sort();
  $('#manTz').innerHTML = zones.map((z) => `<option>${esc(z)}</option>`).join('');
  $('#manTz').value = S.location?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('#manSave').onclick = () => {
    const lat = parseFloat($('#manLat').value), lon = parseFloat($('#manLon').value);
    if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) { toast('Breitengrad −90 bis 90, Längengrad −180 bis 180'); return; }
    setLocation({ name: $('#manName').value.trim() || `${lat.toFixed(3)}, ${lon.toFixed(3)}`, region: '', country: '', cc: '', lat, lon, tz: $('#manTz').value });
  };

  $('#voices').addEventListener('change', (e) => { if (e.target.name === 'voice') commit({ voice: e.target.value }); });
  $('#voices').addEventListener('click', async (e) => {
    const b = e.target.closest('.preview'); if (!b) return;
    const id = b.dataset.voice;
    if (player.current?.id === id) { player.stop(); return; }
    try {
      const ok = await player.play(id, { volume: S.volume });
      if (!ok && player.current?.id !== id) toast('Aufnahme gerade nicht erreichbar. Prüfe die Internetverbindung.');
    } catch { toast('Tippe noch einmal, um abzuspielen'); }
  });
  $('#fajrVoice').onchange = (e) => commit({ fajrVoice: e.target.value });
  $('#volume').oninput = (e) => { if (player.el) player.el.volume = +e.target.value; };
  $('#volume').onchange = (e) => commit({ volume: +e.target.value });
  $('#preReminder').onchange = (e) => commit({ pre: +e.target.value });
  $('#modes').addEventListener('change', (e) => { const k = e.target.name?.replace('mode-', ''); if (k) commit({ modes: { ...S.modes, [k]: e.target.value } }); });
  $('#customFile').onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 25 * 1024 * 1024) { toast('Die Datei ist größer als 25 MB'); return; }
    try {
      if (plat.isDesktop) await plat.api('/api/custom-audio', { method: 'POST', body: f, raw: true });
      else await saveCustom(f);
      hasCustom = true; commit({ voice: 'custom' }); toast('Eigene Aufnahme gespeichert');
    } catch { toast('Datei konnte nicht gespeichert werden'); }
  };

  $('#method').onchange = (e) => commit({ calc: { ...S.calc, method: e.target.value }, methodAuto: false });
  for (const [id, key] of [['#cFajr', 'fajr'], ['#cIsha', 'isha'], ['#cIshaMin', 'ishaMin']]) {
    $(id).onchange = (e) => commit({ calc: { ...S.calc, custom: { ...S.calc.custom, [key]: +e.target.value } } });
  }
  $$('input[name="asr"]').forEach((r) => (r.onchange = () => commit({ calc: { ...S.calc, asr: r.value }, methodAuto: false })));
  $('#highLat').onchange = (e) => commit({ calc: { ...S.calc, highLat: e.target.value } });
  $('#adjustGrid').addEventListener('change', (e) => { const k = e.target.dataset.adj; if (k) commit({ calc: { ...S.calc, adjust: { ...S.calc.adjust, [k]: +e.target.value } } }); });
  $$('input[name="clock"]').forEach((r) => (r.onchange = () => commit({ clock: r.value })));
  $('#hijriAdj').onchange = (e) => commit({ hijriAdj: +e.target.value });
  $$('input[name="athanLength"]').forEach((r) => (r.onchange = () => {
    commit({ athanLength: r.value });
    toast(r.value === 'short' ? 'Athan: die ersten Verse' : 'Athan: ganz');
  }));
  $('#barkSave').onclick = saveBark;
  $('#barkKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBark(); });
  $('#barkCritical').onchange = (e) => { if (S.bark.key) commit({ bark: { ...S.bark, critical: e.target.checked } }); };
  $('#barkTest').onclick = () => barkTest(false);
  $('#barkRemove').onclick = () => { commit({ bark: { key: '', critical: false } }); toast('Bark getrennt. Mitteilungen kommen wieder mit dem normalen Ton.', 4000); };
  $('#widgetCopy').onclick = copyWidget;

  $('#notifyEnable').onclick = enableAll;
  $('#notifyTest').onclick = async () => {
    if (plat.isDesktop) { await plat.api('/api/test', { method: 'POST' }).catch(() => {}); toast('Test gesendet'); return; }
    if (plat.notifPermission() !== 'granted') { await enableAll(); if (plat.notifPermission() !== 'granted') return; }
    const viaPush = await plat.testPush().catch(() => false);
    if (!viaPush) plat.showNotification('Athan – Test', { body: 'So sieht eine Gebetszeit-Benachrichtigung aus.', tag: 'test' });
    toast(viaPush ? 'Test über den Push-Server gesendet' : 'Test-Benachrichtigung angezeigt');
  };
  $('#pushTest').onclick = async () => {
    const ok = await plat.testPush(60).catch(() => false);
    toast(ok ? 'Sperre jetzt das Handy. In etwa 1 Minute kommt die Mitteilung.' : 'Test fehlgeschlagen – bitte Mitteilungen erlauben', 6000);
  };
  $('#athanTest').onclick = async () => {
    if (plat.isDesktop) { await plat.api('/api/test-athan', { method: 'POST' }).catch(() => toast('Test fehlgeschlagen')); return; }
    await player.unlock();
    const now = Date.now();
    fire({ prayer: 'maghrib', at: now, date: zonedParts(now, tz()), test: true });
  };
  $('#autostart').onchange = (e) => plat.api('/api/autostart', { method: 'POST', body: { enabled: e.target.checked } }).then((r) => { desktopState.autostart = r.autostart; }).catch(() => toast('Autostart konnte nicht geändert werden'));
  $('#openOnAthan').onchange = (e) => commit({ openOnAthan: e.target.checked });

  // Kein Zoomen (iOS ignoriert user-scalable=no, daher Gesten abfangen)
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

  // erste Berührung schaltet Audio frei (iOS/Safari)
  document.addEventListener('pointerdown', () => player.unlock(), { once: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { lastMinute = -1; tick(); if ((location.hash || '').includes('qibla')) Compass.onShow(); }
  });

  // Push vom Service Worker, während die App offen ist → Athan abspielen
  navigator.serviceWorker?.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'athan' && d.prayer && !player.playing) {
      const key = `${d.prayer}:${d.at}`;
      if (!fired.has(key)) { remember(key); fire({ prayer: d.prayer, at: d.at, date: zonedParts(d.at, tz()) }); }
    }
  });

  player.on(() => {
    if ((location.hash || '').includes('einstellungen')) renderSettings();
    if (!player.playing && !plat.isDesktop && !pendingPrayer) hideOverlay();
    if (!player.playing && plat.isDesktop && desktopState.playing?.client && !pendingPrayer) { plat.api('/api/stop', { method: 'POST' }).catch(() => {}); hideOverlay(); }
  });
}

function tick() {
  const now = Date.now();
  renderToday(now);
  checkSchedule(now);
}

async function pollDesktop() {
  try {
    const st = await plat.api('/api/status');
    const was = desktopState.playing;
    desktopState = st;
    if (st.playing && (!was || was.at !== st.playing.at)) {
      showOverlay(st.playing.prayer, zonedParts(st.playing.at, tz()), st.playing.voice);
      // Ersatzweg: Windows konnte nicht abspielen → das Fenster spielt den Athan
      if (st.playing.client) playAthan(st.playing.voice).catch(() => setPending(st.playing.prayer));
    }
    if (!st.playing && was) { if (was.client) player.stop(); hideOverlay(); }
  } catch { /* App wird beendet */ }
}

async function init() {
  player = new Player(async (id) => {
    if (id === 'custom') {
      if (plat.isDesktop) return [plat.desktopAudioUrl('custom')];
      const f = await loadCustom(); return f ? [URL.createObjectURL(f)] : [];
    }
    if (plat.isDesktop) return [plat.desktopAudioUrl(id)];
    const v = voices.find((x) => x.id === id); if (!v) return [];
    const info = await plat.detectServer();
    return [...(info?.audio ? [`audio/${encodeURIComponent(id)}`] : []), ...v.src];
  });
  initSky();
  try { voices = (await (await fetch('muezzins.json')).json()).voices; } catch { voices = []; }
  if (!plat.isDesktop) {
    try {
      const cfg = await (await fetch('config.json', { cache: 'no-store' })).json();
      const target = cfg.appUrl && new URL(cfg.appUrl);
      if (target && target.origin !== location.origin && target.protocol === 'https:') {
        $('#moveLink').href = target.href;
        $('#movePrompt').hidden = false;
      }
    } catch { /* keine Konfiguration */ }
  }
  if (plat.isDesktop) {
    try {
      const st = await plat.api('/api/state');
      if (st.settings) { S = sanitize(st.settings); saveLocal(S); }
      else if (S.location) plat.api('/api/settings', { method: 'PUT', body: S }).catch(() => {});
      desktopState.autostart = st.autostart; hasCustom = !!st.hasCustom;
    } catch {}
    setInterval(pollDesktop, 2000);
  } else {
    hasCustom = !!(await loadCustom());
    await plat.registerSW();
    if (plat.notifPermission() === 'granted' && S.location) plat.syncPush(pushSettings()).catch(() => {});
  }
  bind();
  route();
  tick();
  setInterval(tick, 1000);
  const q = new URLSearchParams(location.search);
  const qa = q.get('athan'), qat = +q.get('at');
  if (qa && INFO[qa] && qat && Math.abs(Date.now() - qat) < 20 * 60000 && S.location) {
    history.replaceState(null, '', location.pathname + (location.hash || '#heute'));
    const key = `${qa}:${qat}`;
    if (!fired.has(key)) remember(key);
    showOverlay(qa, zonedParts(qat, tz()), voiceFor(qa));
    playAthan(voiceFor(qa)).catch(() => setPending(qa));
  }
}

init();
