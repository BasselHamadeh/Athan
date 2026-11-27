// Athan-Widget für Scriptable (iPhone) – Version 1.4.0
// https://github.com/BasselHamadeh/Athan · keine Werbung, kein Tracking, rechnet ohne Internet.
// Aktualisiert sich selbst und übernimmt Ort und Einstellungen aus der Athan-App.

const CONFIG = /*CONFIG*/{"name":"","lat":null,"lon":null,"tz":"","calc":{"method":"MWL","asr":"standard","highLat":"angle","adjust":{}},"clock":"24","hijriAdj":0}/*END*/;
const WIDGET_VERSION = '1.4.0';

// ---- praytimes.js ----
const M_praytimes = (() => {
// Gebetszeiten-Engine – astronomische Berechnung (nach dem PrayTimes.org-Verfahren)
// Läuft im Browser, im Service Worker und in Node (Push-Server). Keine Abhängigkeiten.

const KAABA = { lat: 21.422487, lon: 39.826206 };

// Berechnungsmethoden: Winkel in Grad, *_min = Minuten nach Maghrib/Sonnenuntergang
const METHODS = {
  MWL:       { name: 'Muslimische Weltliga', fajr: 18, isha: 17 },
  ISNA:      { name: 'ISNA (Nordamerika)', fajr: 15, isha: 15 },
  Egypt:     { name: 'Ägyptische Vermessungsbehörde', fajr: 19.5, isha: 17.5 },
  Makkah:    { name: 'Umm al-Qura (Mekka)', fajr: 18.5, isha_min: 90, ramadan_isha_min: 120 },
  Karachi:   { name: 'Universität Karachi', fajr: 18, isha: 18 },
  Turkey:    { name: 'Diyanet (Türkei)', fajr: 18, isha: 17, adjust: { sunrise: -7, dhuhr: 5, asr: 4, maghrib: 7 } },
  Dubai:     { name: 'Dubai (VAE)', fajr: 18.2, isha: 18.2, adjust: { sunrise: -3, dhuhr: 3, asr: 3, maghrib: 3 } },
  Kuwait:    { name: 'Kuwait', fajr: 18, isha: 17.5 },
  Qatar:     { name: 'Katar', fajr: 18, isha_min: 90 },
  Gulf:      { name: 'Golfregion', fajr: 19.5, isha_min: 90 },
  Singapore: { name: 'Singapur / Indonesien', fajr: 20, isha: 18 },
  JAKIM:     { name: 'JAKIM (Malaysia)', fajr: 20, isha: 18 },
  France:    { name: 'UOIF (Frankreich)', fajr: 12, isha: 12 },
  Russia:    { name: 'Russland (DUM)', fajr: 16, isha: 15 },
  Tehran:    { name: 'Teheran (Geophysik-Institut)', fajr: 17.7, isha: 14, maghrib: 4.5, midnight: 'jafari' },
  Jafari:    { name: 'Schiitisch (Ithna Ashari, Qom)', fajr: 16, isha: 14, maghrib: 4, midnight: 'jafari' },
  Custom:    { name: 'Eigene Winkel', fajr: 18, isha: 17 },
};

// Vorschlag je Land (ISO-Code), wenn der Nutzer die Methode nicht selbst gewählt hat
const COUNTRY_METHOD = {
  SA: 'Makkah', YE: 'Makkah',
  EG: 'Egypt', SY: 'Egypt', LB: 'Egypt', JO: 'Egypt', PS: 'Egypt', IQ: 'Egypt', SD: 'Egypt', LY: 'Egypt',
  TR: 'Turkey', AZ: 'Turkey',
  AE: 'Dubai', KW: 'Kuwait', QA: 'Qatar', BH: 'Gulf', OM: 'Gulf',
  PK: 'Karachi', IN: 'Karachi', BD: 'Karachi', AF: 'Karachi',
  US: 'ISNA', CA: 'ISNA',
  IR: 'Tehran', SG: 'Singapore', ID: 'Singapore', BN: 'Singapore', MY: 'JAKIM',
  FR: 'France', RU: 'Russia',
};
const HANAFI_COUNTRIES = new Set(['TR', 'PK', 'IN', 'BD', 'AF', 'AZ']);

function suggestMethod(countryCode) {
  const cc = (countryCode || '').toUpperCase();
  return { method: COUNTRY_METHOD[cc] || 'MWL', asr: HANAFI_COUNTRIES.has(cc) ? 'hanafi' : 'standard' };
}

const PRAYERS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

const DEFAULT_CALC = {
  method: 'MWL',
  asr: 'standard',          // 'standard' (Schafii, Maliki, Hanbali) | 'hanafi'
  highLat: 'angle',         // 'angle' | 'seventh' | 'middle' | 'none'
  adjust: { fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 },
  custom: { fajr: 18, isha: 17, ishaMin: 0, maghribMin: 0 },
};

// ---------- Mathematik ----------
const DEG = Math.PI / 180;
const dsin = (d) => Math.sin(d * DEG);
const dcos = (d) => Math.cos(d * DEG);
const dtan = (d) => Math.tan(d * DEG);
const darcsin = (x) => Math.asin(x) / DEG;
const darccos = (x) => Math.acos(x) / DEG;
const darctan2 = (y, x) => Math.atan2(y, x) / DEG;
const darccot = (x) => Math.atan(1 / x) / DEG;
const fix = (a, b) => { a = a - b * Math.floor(a / b); return a < 0 ? a + b : a; };
const fixAngle = (a) => fix(a, 360);
const fixHour = (a) => fix(a, 24);
const timeDiff = (t1, t2) => fixHour(t2 - t1);

function julian(y, m, d) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}

function sunPosition(jd) {
  const D = jd - 2451545.0;
  const g = fixAngle(357.529 + 0.98560028 * D);
  const q = fixAngle(280.459 + 0.98564736 * D);
  const L = fixAngle(q + 1.915 * dsin(g) + 0.020 * dsin(2 * g));
  const e = 23.439 - 0.00000036 * D;
  const RA = darctan2(dcos(e) * dsin(L), dcos(L)) / 15;
  const eqt = q / 15 - fixHour(RA);
  const decl = darcsin(dsin(e) * dsin(L));
  return { decl, eqt };
}

// Tabellarischer (arithmetischer) Hidschri-Kalender – nur für die Ramadan-Regel von Umm al-Qura.
// Identisch implementiert in der Windows-App (Go), damit beide gleich rechnen.
function hijriArithmetic(y, m, d) {
  const jd = Math.floor(julian(y, m, d) + 0.5);
  const l0 = jd - 1948440 + 10632;
  const n = Math.floor((l0 - 1) / 10631);
  const l1 = l0 - 10631 * n + 354;
  const j = Math.floor((10985 - l1) / 5316) * Math.floor((50 * l1) / 17719) + Math.floor(l1 / 5670) * Math.floor((43 * l1) / 15238);
  const l2 = l1 - Math.floor((30 - j) / 15) * Math.floor((17719 * j) / 50) - Math.floor(j / 16) * Math.floor((15238 * j) / 43) + 29;
  const hm = Math.floor((24 * l2) / 709);
  const hd = l2 - Math.floor((709 * hm) / 24);
  const hy = 30 * n + j - 30;
  return { y: hy, m: hm, d: hd };
}

function resolveParams(calc, date) {
  const c = { ...DEFAULT_CALC, ...(calc || {}) };
  const m = METHODS[c.method] || METHODS.MWL;
  const p = {
    fajr: m.fajr, isha: m.isha ?? null, ishaMin: m.isha_min ?? null,
    maghrib: m.maghrib ?? null, maghribMin: null,
    midnight: m.midnight || 'standard',
    asrFactor: c.asr === 'hanafi' ? 2 : 1,
    highLat: c.highLat || 'angle',
    adjust: {},
  };
  if (c.method === 'Custom') {
    const cu = { ...DEFAULT_CALC.custom, ...(c.custom || {}) };
    p.fajr = num(cu.fajr, 18);
    if (num(cu.ishaMin, 0) > 0) { p.ishaMin = num(cu.ishaMin, 0); p.isha = null; } else { p.isha = num(cu.isha, 17); p.ishaMin = null; }
    if (num(cu.maghribMin, 0) > 0) p.maghribMin = num(cu.maghribMin, 0);
  }
  if (m.ramadan_isha_min && date && hijriArithmetic(date.y, date.m, date.d).m === 9) p.ishaMin = m.ramadan_isha_min;
  for (const k of PRAYERS) p.adjust[k] = num(m.adjust?.[k], 0) + num(c.adjust?.[k], 0);
  return p;
}
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : (isFinite(parseFloat(v)) ? parseFloat(v) : d));

/**
 * Gebetszeiten für ein Kalenderdatum am Ort.
 * @param {{y:number,m:number,d:number}} date  lokales Datum am Ort
 * @param {{lat:number, lon:number}} coords
 * @returns Zeitpunkte als Epoch-Millisekunden (NaN, falls nicht bestimmbar)
 */
function computeDay(date, coords, calc) {
  const out = computeDayAt(date, coords.lat, coords.lon, calc);
  // Polartag/-nacht: kein Sonnenauf-/untergang → Zeiten der nächsten Breite (65°) verwenden
  if ((calc?.highLat ?? 'angle') !== 'none' && Math.abs(coords.lat) > 65 && (!isFinite(out.sunrise) || !isFinite(out.sunset))) {
    return computeDayAt(date, Math.sign(coords.lat) * 65, coords.lon, calc);
  }
  return out;
}

function computeDayAt(date, lat, lon, calc) {
  const { y, m, d } = date;
  const p = resolveParams(calc, date);
  const jDate = julian(y, m, d) - lon / (15 * 24);

  const midDay = (t) => fixHour(12 - sunPosition(jDate + t).eqt);
  const sunAngleTime = (angle, t, ccw) => {
    const decl = sunPosition(jDate + t).decl;
    const noon = midDay(t);
    const x = (-dsin(angle) - dsin(decl) * dsin(lat)) / (dcos(decl) * dcos(lat));
    if (!(x >= -1 && x <= 1)) return NaN;
    const T = darccos(x) / 15;
    return noon + (ccw ? -T : T);
  };
  const asrTime = (factor, t) => {
    const decl = sunPosition(jDate + t).decl;
    const angle = -darccot(factor + dtan(Math.abs(lat - decl)));
    return sunAngleTime(angle, t);
  };
  const riseSet = 0.833;

  const t = {
    fajr: sunAngleTime(p.fajr, 5 / 24, true),
    sunrise: sunAngleTime(riseSet, 6 / 24, true),
    dhuhr: midDay(12 / 24),
    asr: asrTime(p.asrFactor, 13 / 24),
    sunset: sunAngleTime(riseSet, 18 / 24),
    maghrib: p.maghrib != null ? sunAngleTime(p.maghrib, 18 / 24) : NaN,
    isha: p.isha != null ? sunAngleTime(p.isha, 18 / 24) : NaN,
  };
  // lokale Sonnenzeit → UTC-Stunden
  for (const k in t) t[k] += -lon / 15;
  if (p.maghrib == null) t.maghrib = t.sunset;

  // Regeln für hohe Breiten (z. B. Deutschland im Sommer)
  if (p.highLat !== 'none' && isFinite(t.sunrise) && isFinite(t.sunset)) {
    const night = timeDiff(t.sunset, t.sunrise);
    const portion = (angle) => {
      if (p.highLat === 'seventh') return night / 7;
      if (p.highLat === 'middle') return night / 2;
      return (angle / 60) * night;
    };
    const fp = portion(p.fajr);
    if (!isFinite(t.fajr) || timeDiff(t.fajr, t.sunrise) > fp) t.fajr = t.sunrise - fp;
    if (p.isha != null) {
      const ip = portion(p.isha);
      if (!isFinite(t.isha) || timeDiff(t.sunset, t.isha) > ip) t.isha = t.sunset + ip;
    }
    if (p.maghrib != null) {
      const mp = portion(p.maghrib);
      if (!isFinite(t.maghrib) || timeDiff(t.sunset, t.maghrib) > mp) t.maghrib = t.sunset + mp;
    }
  }
  if (p.maghribMin != null) t.maghrib = t.sunset + p.maghribMin / 60;
  if (p.ishaMin != null) t.isha = t.maghrib + p.ishaMin / 60;

  // Mitternacht & letztes Drittel (vor den Minutenkorrekturen, aus Sonnenuntergang)
  const nightEnd = p.midnight === 'jafari' ? t.fajr : t.sunrise;
  const nightLen = timeDiff(t.sunset, nightEnd);
  const midnight = t.sunset + nightLen / 2;
  const lastThird = t.sunset + (nightLen * 2) / 3;

  for (const k of PRAYERS) t[k] += (p.adjust[k] || 0) / 60;

  const base = Date.UTC(y, m - 1, d);
  const toEpoch = (h) => (isFinite(h) ? Math.round((base + h * 3600000) / 60000) * 60000 : NaN);
  const out = {};
  for (const k of PRAYERS) out[k] = toEpoch(t[k]);
  out.sunset = toEpoch(t.sunset);
  out.imsak = isFinite(out.fajr) ? out.fajr - 10 * 60000 : NaN;
  out.midnight = toEpoch(midnight);
  out.lastThird = toEpoch(lastThird);
  return out;
}

// ---------- Zeitzonen (über Intl, funktioniert für jeden IANA-Namen) ----------
const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}
function zonedParts(epoch, tz) {
  const parts = {};
  for (const p of dtf(tz).formatToParts(new Date(epoch))) parts[p.type] = p.value;
  return {
    y: +parts.year, m: +parts.month, d: +parts.day,
    h: +parts.hour % 24, min: +parts.minute, s: +parts.second, wd: parts.weekday,
  };
}
function isValidTimeZone(tz) {
  try { dtf(tz); return true; } catch { return false; }
}
function addDays({ y, m, d }, n) {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Liste der kommenden Ereignisse (Gebete) ab `from` für `days` Tage am Ort. */
function upcomingEvents(location, calc, from = Date.now(), days = 2) {
  const tz = location.tz && isValidTimeZone(location.tz) ? location.tz : 'UTC';
  const today = zonedParts(from, tz);
  const ev = [];
  for (let i = -1; i <= days; i++) {
    const date = addDays(today, i);
    const t = computeDay(date, location, calc);
    for (const k of PRAYERS) if (isFinite(t[k])) ev.push({ prayer: k, at: t[k], date });
  }
  return ev.filter((e) => e.at >= from).sort((a, b) => a.at - b.at);
}

// ---------- Qibla ----------
function qiblaBearing(lat, lon) {
  const p1 = lat * DEG, p2 = KAABA.lat * DEG, dl = (KAABA.lon - lon) * DEG;
  const b = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
  return fixAngle(b / DEG);
}
function distanceToKaabaKm(lat, lon) {
  const R = 6371.0088;
  const p1 = lat * DEG, p2 = KAABA.lat * DEG;
  const dp = (KAABA.lat - lat) * DEG, dl = (KAABA.lon - lon) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Sonnenhöhe (Grad) zu einem Zeitpunkt – für den Himmelsverlauf im UI
function sunAltitude(epoch, lat, lon) {
  const jd = epoch / 86400000 + 2440587.5;
  const { decl, eqt } = sunPosition(jd);
  const utcH = ((epoch / 3600000) % 24 + 24) % 24;
  const solarH = utcH + lon / 15 + eqt;
  const ha = (solarH - 12) * 15;
  return darcsin(dsin(lat) * dsin(decl) + dcos(lat) * dcos(decl) * dcos(ha));
}
return { KAABA, METHODS, suggestMethod, PRAYERS, DEFAULT_CALC, hijriArithmetic, computeDay, zonedParts, isValidTimeZone, addDays, upcomingEvents, qiblaBearing, distanceToKaabaKm, sunAltitude };
})();

// ---- hijri.js ----
const M_hijri = (() => {
// Islamischer Kalender (Umm al-Qura) mit Tagesanpassung ±1, Ramadan und besondere Tage.
const { hijriArithmetic } = M_praytimes;
const DAY = 86400000;
const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (f === undefined) {
    try { f = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { timeZone: tz, day: 'numeric', month: 'numeric', year: 'numeric' }); }
    catch { f = null; }
    fmtCache.set(tz, f);
  }
  return f;
}

/** Hidschri-Datum {d, m, y} für einen Zeitpunkt am Ort (adj = Tage Verschiebung). */
function hijriParts(epoch, tz, adj = 0) {
  const t = epoch + adj * DAY;
  const f = fmt(tz);
  if (f) {
    const p = {};
    for (const x of f.formatToParts(t)) p[x.type] = x.value;
    if (p.day && p.month && p.year) return { d: +p.day, m: +p.month, y: parseInt(p.year, 10) };
  }
  const g = new Date(t);
  return hijriArithmetic(g.getUTCFullYear(), g.getUTCMonth() + 1, g.getUTCDate());
}

const isRamadan = (epoch, tz, adj = 0) => hijriParts(epoch, tz, adj).m === 9;

/** Tage bis zum 1. Ramadan (0 = heute ist Ramadan), höchstens `max`, sonst null. */
function daysUntilRamadan(epoch, tz, adj = 0, max = 60) {
  for (let i = 0; i <= max; i++) {
    const h = hijriParts(epoch + i * DAY, tz, adj);
    if (h.m === 9) return i === 0 ? (h.d === 1 ? 0 : -h.d + 1) : i;
  }
  return null;
}

/** Besonderer Tag (oder null): { de, ar, kind } – kind steuert die Gestaltung. */
function specialDay(epoch, tz, adj = 0) {
  const h = hijriParts(epoch, tz, adj);
  if (h.m === 9) {
    return h.d >= 21
      ? { kind: 'ramadan', de: `Ramadan, Tag ${h.d}. Die letzten zehn Nächte`, ar: 'رمضان كريم', day: h.d }
      : { kind: 'ramadan', de: `Ramadan, Tag ${h.d}`, ar: 'رمضان كريم', day: h.d };
  }
  if (h.m === 10 && h.d <= 3) return { kind: 'eid', de: 'Eid al-Fitr. Eid Mubarak', ar: 'عيد مبارك' };
  if (h.m === 12 && h.d === 9) return { kind: 'holy', de: 'Tag von Arafah', ar: 'يوم عرفة' };
  if (h.m === 12 && h.d >= 10 && h.d <= 13) return { kind: 'eid', de: 'Eid al-Adha. Eid Mubarak', ar: 'عيد مبارك' };
  if (h.m === 1 && h.d === 1) return { kind: 'holy', de: `Neues Hidschri-Jahr ${h.y}`, ar: 'سنة هجرية مباركة' };
  if (h.m === 1 && h.d === 10) return { kind: 'holy', de: 'Aschura', ar: 'عاشوراء' };
  if (h.m === 8 || (h.m === 7 && h.d >= 20)) {
    const n = daysUntilRamadan(epoch, tz, adj, 45);
    if (n === 1) return { kind: 'soon', de: 'Morgen beginnt Ramadan', ar: 'رمضان', days: 1 };
    if (n && n <= 40) return { kind: 'soon', de: `Noch ${n} Tage bis Ramadan`, ar: 'رمضان', days: n };
  }
  return null;
}

const PHASES = ['Neumond', 'Zunehmende Sichel', 'Erstes Viertel', 'Zunehmender Mond', 'Vollmond', 'Abnehmender Mond', 'Letztes Viertel', 'Abnehmende Sichel'];
function moonPhaseName(phase) {
  return PHASES[Math.round(((phase % 1) + 1) % 1 * 8) % 8];
}
return { hijriParts, isRamadan, daysUntilRamadan, specialDay, moonPhaseName };
})();

// ---- astro.js ----
const M_astro = (() => {
// Mond: Position (Azimut/Höhe) und Phase für Ort und Zeit.
// Vereinfachte Formeln aus der astronomischen Standardliteratur (Genauigkeit etwa 1°) – genug für die Anzeige.

const PI = Math.PI, rad = PI / 180, dayMs = 86400000, J1970 = 2440588, J2000 = 2451545;
const toDays = (ms) => ms / dayMs - 0.5 + J1970 - J2000;
const e = rad * 23.4397; // Schiefe der Ekliptik

const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
const azimuthOf = (H, phi, dec) => Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
const altitudeOf = (H, phi, dec) => Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;
const refraction = (h) => { const x = Math.max(h, 0); return 0.0002967 / Math.tan(x + 0.00312536 / (x + 0.08901179)); };

function sunCoords(d) {
  const M = rad * (357.5291 + 0.98560028 * d);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + PI;
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

function moonCoords(d) {
  const L = rad * (218.316 + 13.176396 * d);  // mittlere Länge
  const M = rad * (134.963 + 13.064993 * d);  // mittlere Anomalie
  const F = rad * (93.272 + 13.22935 * d);    // mittlerer Abstand vom Knoten
  const l = L + rad * 6.289 * Math.sin(M);
  const b = rad * 5.128 * Math.sin(F);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: 385001 - 20905 * Math.cos(M) };
}

/** Azimut (Grad, 0 = Süden, positiv = Westen), Höhe (Grad) und parallaktischer Winkel (Radiant). */
function moonPosition(ms, lat, lon) {
  const lw = rad * -lon, phi = rad * lat, d = toDays(ms);
  const c = moonCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  const h = altitudeOf(H, phi, c.dec);
  const pa = Math.atan2(Math.sin(H), Math.tan(phi) * Math.cos(c.dec) - Math.sin(c.dec) * Math.cos(H));
  return { azimuth: azimuthOf(H, phi, c.dec) / rad, altitude: (h + refraction(h)) / rad, parallacticAngle: pa };
}

/** Beleuchteter Anteil (0–1), Phase (0 Neumond, 0,5 Vollmond) und Richtung der hellen Seite (Radiant). */
function moonIllumination(ms) {
  const d = toDays(ms), s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / PI, angle };
}

/** SVG-Pfad des beleuchteten Teils (Mittelpunkt 0,0) – helle Seite zeigt nach rechts, danach drehen. */
function moonLitPath(fraction, r) {
  const f = Math.min(1, Math.max(0, fraction));
  const rx = Math.abs(2 * f - 1) * r;
  return `M0 ${-r} A${r} ${r} 0 0 1 0 ${r} A${rx.toFixed(2)} ${r} 0 0 ${f > 0.5 ? 1 : 0} 0 ${-r} Z`;
}

/** Drehung (Grad, im Uhrzeigersinn) für die helle Seite, aus Sicht des Betrachters. */
function moonRotation(ms, lat, lon) {
  const z = moonIllumination(ms).angle - moonPosition(ms, lat, lon).parallacticAngle;
  return -z / rad - 90;
}
return { moonPosition, moonIllumination, moonLitPath, moonRotation };
})();

// ---- palette.js ----
const M_palette = (() => {
// Himmelsfarben nach Sonnenhöhe – gemeinsam für die App und das iPhone-Widget.
// Zwei Verläufe: Morgen (Fajr → Shuruq → Vormittag) und Abend (Asr → Maghrib → Isha).

const NIGHT = { top: '#01040C', mid: '#030916', low: '#07112A', glow: [40, 60, 140, 0], stars: 1 };
const NOON = { top: '#0C467E', mid: '#18659C', low: '#24709C', glow: [255, 245, 210, 0.10], stars: 0 };
const MORNING = [
  { a: -90, ...NIGHT },
  { a: -18, top: '#030A1E', mid: '#081633', low: '#10244C', glow: [90, 80, 160, 0.08], stars: 0.95 },
  { a: -12, top: '#0B1440', mid: '#1E225A', low: '#3A2F68', glow: [180, 120, 190, 0.22], stars: 0.6 },
  { a: -5, top: '#141C52', mid: '#3A2F6A', low: '#6A4272', glow: [236, 150, 150, 0.32], stars: 0.2 },
  { a: 2, top: '#1B2E66', mid: '#4A4A80', low: '#7A5068', glow: [250, 175, 120, 0.40], stars: 0 },
  { a: 12, top: '#143C70', mid: '#2B5A8A', low: '#3F6A8A', glow: [255, 215, 150, 0.22], stars: 0 },
  { a: 35, top: '#0E447A', mid: '#1B6296', low: '#2A6E98', glow: [255, 240, 200, 0.12], stars: 0 },
  { a: 90, ...NOON },
];
const EVENING = [
  { a: -90, ...NIGHT },
  { a: -18, top: '#030A1E', mid: '#081633', low: '#10244C', glow: [60, 60, 140, 0.05], stars: 0.95 },
  { a: -12, top: '#0D1336', mid: '#1E1D4E', low: '#2E2454', glow: [120, 70, 140, 0.14], stars: 0.6 },
  { a: -6, top: '#171844', mid: '#3E2456', low: '#5A2A4A', glow: [200, 80, 90, 0.28], stars: 0.2 },
  { a: 0, top: '#231F52', mid: '#6A3456', low: '#9A3E32', glow: [245, 110, 70, 0.42], stars: 0 },
  { a: 8, top: '#1E3462', mid: '#5A4A6A', low: '#8A5040', glow: [250, 160, 90, 0.34], stars: 0 },
  { a: 22, top: '#163E6C', mid: '#3A5C7E', low: '#7A6448', glow: [245, 200, 120, 0.24], stars: 0 },
  { a: 35, top: '#0E447A', mid: '#1B6296', low: '#2A6E98', glow: [255, 240, 200, 0.12], stars: 0 },
  { a: 90, ...NOON },
];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lerp = (a, b, t) => a + (b - a) * t;
const mixRGB = (h1, h2, t) => hex(h1).map((v, i) => Math.round(lerp(v, hex(h2)[i], t)));

/** Farben für eine Sonnenhöhe (Grad): top/mid/low als [r,g,b], glow als [r,g,b,a], stars 0–1. */
function skyAt(alt, evening) {
  const KF = evening ? EVENING : MORNING;
  let i = KF.findIndex((k) => k.a >= alt); if (i <= 0) i = 1;
  const a = KF[i - 1], b = KF[i], t = Math.min(1, Math.max(0, (alt - a.a) / (b.a - a.a)));
  return {
    top: mixRGB(a.top, b.top, t), mid: mixRGB(a.mid, b.mid, t), low: mixRGB(a.low, b.low, t),
    glow: a.glow.map((v, k) => lerp(v, b.glow[k], t)), stars: lerp(a.stars, b.stars, t),
  };
}
return { NIGHT, NOON, MORNING, EVENING, skyAt };
})();

const { computeDay, upcomingEvents, zonedParts, addDays, sunAltitude } = M_praytimes;
const { hijriParts, specialDay } = M_hijri;
const { moonPosition, moonIllumination, moonRotation } = M_astro;
const { skyAt } = M_palette;

// ---------- Widget (Scriptable) ----------
// Klein: alle Zeiten als Liste · Mittel: nächstes Gebet + alle Zeiten · Groß: dazu Datum, Hidschri, Mond
// Sperrbildschirm: groß das nächste Gebet, klein das danach · rund · als Zeile über der Uhr.
// Rechnet auf dem iPhone ohne Internet. Mit Internet: übernimmt Ort/Einstellungen aus der Athan-App
// (stündlich) und aktualisiert sich selbst, wenn es eine neue Version gibt (zweimal am Tag).

let C = CONFIG;
const DAY = 86400000;
const NAMES = {
  fajr: ['Fajr', 'الفجر'], sunrise: ['Shuruq', 'الشروق'], dhuhr: ['Dhuhr', 'الظهر'], asr: ['Asr', 'العصر'],
  maghrib: ['Maghrib', 'المغرب'], isha: ['Isha', 'العشاء'], qiyam: ['Qiyam', 'القيام'],
};
const SYMBOL = { fajr: 'sun.haze.fill', sunrise: 'sunrise.fill', dhuhr: 'sun.max.fill', asr: 'sun.min.fill', maghrib: 'sunset.fill', isha: 'moon.stars.fill' };
const ORDER = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha', 'qiyam'];

const GOLD = new Color('#D8B26E');
const INK = new Color('#F1E9D6');
const INK2 = new Color('#F1E9D6', 0.74);
const INK3 = new Color('#F1E9D6', 0.52);
const PILL = new Color('#D8B26E', 0.17);
const serif = (size, bold) => new Font(bold ? 'IowanOldStyle-Bold' : 'IowanOldStyle-Roman', size);
const arabic = (size) => new Font('GeezaPro', size);
const digits = (size, weight = 'semibold') => (weight === 'bold' ? Font.boldRoundedSystemFont(size) : weight === 'medium' ? Font.mediumRoundedSystemFont(size) : Font.semiboldRoundedSystemFont(size));

// ---------- Einstellungen: eingebettet, zwischengespeichert, aus der App ----------
const hasPlace = () => Number.isFinite(C.lat) && Number.isFinite(C.lon) && typeof C.tz === 'string' && !!C.tz;
let timeFmt = null;
function useConfig(cfg) { C = cfg; timeFmt = null; }

function stateFile() { const fm = FileManager.local(); return [fm, fm.joinPath(fm.documentsDirectory(), 'athan-widget.json')]; }
function readState() {
  try { const [fm, p] = stateFile(); return fm.fileExists(p) ? JSON.parse(fm.readString(p)) || {} : {}; } catch { return {}; }
}
function writeState(s) { try { const [fm, p] = stateFile(); fm.writeString(p, JSON.stringify(s)); } catch { /* nicht schlimm */ } }

const validServer = (s) => typeof s === 'string' && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s);

// Ort und Berechnung so, wie in der Athan-App eingestellt (über den eigenen Server) – fällt sonst auf
// den zuletzt geladenen Stand bzw. den eingebetteten Code zurück.
async function loadConfig(state, now) {
  const base = CONFIG;
  let cfg = state.cfg && state.cfgFor === base.id ? { ...base, ...state.cfg } : base;
  if (base.id && validServer(base.server) && now - (state.cfgAt || 0) > 3600000) {
    state.cfgAt = now;
    try {
      const r = new Request(`${base.server}/api/widget?id=${encodeURIComponent(base.id)}`);
      r.timeoutInterval = 6;
      const j = await r.loadJSON();
      if (j && Number.isFinite(j.lat) && Number.isFinite(j.lon) && typeof j.tz === 'string' && j.calc && typeof j.calc === 'object') {
        state.cfg = { name: String(j.name || ''), lat: j.lat, lon: j.lon, tz: j.tz, calc: j.calc, clock: j.clock === '12' ? '12' : '24', hijriAdj: [-1, 0, 1].includes(j.hijriAdj) ? j.hijriAdj : 0 };
        state.cfgFor = base.id;
        cfg = { ...base, ...state.cfg };
      }
    } catch (e) { console.log('Einstellungen nicht geladen: ' + e); }
    writeState(state);
  }
  return cfg;
}

const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };

// Neue Version vom eigenen Server holen und sich selbst ersetzen – die eigenen Einstellungen bleiben erhalten.
async function selfUpdate(state, now) {
  if (!validServer(CONFIG.server) || now - (state.codeAt || 0) < 12 * 3600000) return false;
  state.codeAt = now;
  writeState(state);
  try {
    const r = new Request(`${CONFIG.server}/widget/athan-widget.js`);
    r.timeoutInterval = 8;
    const code = await r.loadString();
    const v = /WIDGET_VERSION = '(\d+\.\d+\.\d+)'/.exec(code)?.[1];
    if (!v || !newer(v, WIDGET_VERSION) || !code.includes('/*CONFIG*/') || !/await main\(\);\s*$/.test(code)) return false;
    const mine = code.replace(/\/\*CONFIG\*\/[\s\S]*?\/\*END\*\//, () => `/*CONFIG*/${JSON.stringify(CONFIG)}/*END*/`);
    const fm = FileManager.iCloud().isFileStoredIniCloud(module.filename) ? FileManager.iCloud() : FileManager.local();
    fm.writeString(module.filename, mine);
    console.log(`Athan-Widget aktualisiert: ${WIDGET_VERSION} → ${v}`);
    return true;
  } catch (e) { console.log('Update nicht möglich: ' + e); return false; }
}

// ---------- Daten ----------
function fmt(ms) {
  if (!Number.isFinite(ms)) return '–';
  if (!timeFmt) timeFmt = new Intl.DateTimeFormat('de-DE', { timeZone: C.tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: C.clock === '12' ? 'h12' : 'h23' });
  return timeFmt.format(ms);
}
const sameDay = (a, b) => a.y === b.y && a.m === b.m && a.d === b.d;

function dayData(now) {
  const loc = { lat: C.lat, lon: C.lon, tz: C.tz };
  const z = zonedParts(now, C.tz);
  const today = { y: z.y, m: z.m, d: z.d };
  const events = upcomingEvents(loc, C.calc, now - 1000, 2);
  const next = events.find((e) => e.at > now) || null;
  // Angezeigt wird der Tag des nächsten Gebets – nach Isha also schon morgen
  const D = next ? next.date : today;
  const t = computeDay(D, loc, C.calc);
  const prev = computeDay(addDays(D, -1), loc, C.calc);
  const tt = sameDay(D, today) ? t : computeDay(today, loc, C.calc);
  // Qiyam: Beginn des letzten Nachtdrittels – vor Fajr die laufende Nacht, danach die kommende
  const times = { ...t, qiyam: now < t.fajr ? prev.lastThird : t.lastThird };
  const after = next ? events.filter((e) => e.at > next.at).slice(0, 2) : [];
  const hNext = next ? hijriParts(next.at, C.tz, C.hijriAdj || 0) : null;
  return { now, today, D, t, tt, times, next, after, tomorrow: !sameDay(D, today), ramadanNext: hNext?.m === 9 };
}

// Name für eine Zeile – im Ramadan heißt Maghrib „Iftar“
const shownName = (d, e) => (d.ramadanNext && e === d.next && e.prayer === 'maghrib' ? 'Iftar' : NAMES[e.prayer][0]);

function nextLabel(d) {
  if (!d.next) return '';
  const p = d.next.prayer;
  if (p === 'sunrise') return 'Fajr-Zeit endet';
  if (d.ramadanNext && p === 'maghrib') return 'Fastenbrechen';
  if (d.ramadanNext && p === 'fajr') return 'Suhoor endet';
  return d.tomorrow ? 'Nächstes Gebet, morgen' : 'Nächstes Gebet';
}
// kurzer Hinweis neben der Uhrzeit (nur wenn er etwas sagt)
function sideLabel(d) {
  const p = d.next?.prayer;
  if (p === 'sunrise') return 'Fajr endet';
  if (d.ramadanNext && p === 'fajr') return 'Suhoor endet';
  return d.tomorrow ? 'morgen' : ''; // im Ramadan steht „Iftar“ schon als Name
}

function hijriText(now, locale) {
  const adj = (C.hijriAdj || 0) * DAY;
  try {
    return new Intl.DateTimeFormat(`${locale}-u-ca-islamic-umalqura-nu-latn`, { timeZone: C.tz, day: 'numeric', month: 'long', year: 'numeric' })
      .format(now + adj).replace(/\s*(AH|هـ)$/u, '');
  } catch {
    const h = hijriParts(now, C.tz, C.hijriAdj || 0);
    return `${h.d}.${h.m}.${h.y}`;
  }
}
const gregText = (now, opts) => new Intl.DateTimeFormat('de-DE', { timeZone: C.tz, ...opts }).format(now);

// ---------- Himmel als Hintergrundbild (Farben wie in der App, Sterne, echter Mond) ----------
function widgetSize(family) {
  let W = 390;
  try { const s = Device.screenSize(); W = Math.min(s.width, s.height); } catch { /* Standardgröße */ }
  const s = Math.round(W * 0.405), mw = Math.round(W * 0.865);
  if (family === 'small') return [s, s];
  if (family === 'medium') return [mw, s];
  return [mw, Math.round(mw * 1.048)];
}

function rand(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hexOf = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const mixC = (a, b, f) => a.map((v, i) => v + (b[i] - v) * f);

function skyImage(family, d) {
  const [w, h] = widgetSize(family);
  const now = d.now;
  const alt = sunAltitude(now, C.lat, C.lon);
  const evening = Number.isFinite(d.tt.dhuhr) ? now >= d.tt.dhuhr || now < d.tt.fajr - 6 * 3600000 : zonedParts(now, C.tz).h >= 12;
  const c = skyAt(alt, evening);
  const ctx = new DrawContext();
  ctx.size = new Size(w, h);
  ctx.opaque = true;
  ctx.respectScreenScale = true;
  // Verlauf oben → Mitte (52 %) → unten
  const bands = Math.ceil(h / 2);
  for (let i = 0; i < bands; i++) {
    const f = (i + 0.5) / bands;
    const col = f < 0.52 ? mixC(c.top, c.mid, f / 0.52) : mixC(c.mid, c.low, (f - 0.52) / 0.48);
    ctx.setFillColor(new Color(hexOf(col)));
    ctx.fillRect(new Rect(0, (i * h) / bands, w, h / bands + 1));
  }
  // Lichtschein dort, wo die Sonne steht
  const rise = d.tt.sunrise, set = d.tt.sunset;
  let fx = evening ? 0.9 : 0.1, fy = 0.34;
  if (Number.isFinite(rise) && Number.isFinite(set) && now >= rise && now <= set) {
    const f = (now - rise) / (set - rise);
    fx = 0.1 + 0.8 * f; fy = 0.32 - 0.2 * Math.sin(Math.PI * f);
  }
  const [gr, gg, gb, ga] = c.glow;
  if (ga > 0.01) {
    for (let i = 0; i < 12; i++) {
      const k = 1 - i / 12, rx = w * 0.56 * k, ry = h * 0.4 * k;
      ctx.setFillColor(new Color(hexOf([gr, gg, gb]), ga / 9));
      ctx.fillEllipse(new Rect(fx * w - rx, fy * h - ry, rx * 2, ry * 2));
    }
  }
  // Sterne – je dunkler, desto mehr; Lage bleibt bei jeder Aktualisierung gleich
  if (c.stars > 0.05) {
    const r = rand(family.length * 7919 + Math.round(C.lat * 100));
    const n = Math.round((w * h) / 950);
    for (let i = 0; i < n; i++) {
      const x = r() * w, y = r() * h * 0.92, big = r() < 0.08;
      const rad = big ? 1.1 + r() * 0.5 : 0.35 + r() * 0.65;
      const a = (0.25 + r() * 0.65) * c.stars;
      if (big) { ctx.setFillColor(new Color('#FFFFFF', a * 0.18)); ctx.fillEllipse(new Rect(x - rad * 3, y - rad * 3, rad * 6, rad * 6)); }
      ctx.setFillColor(new Color('#FFFFFF', a));
      ctx.fillEllipse(new Rect(x - rad, y - rad, rad * 2, rad * 2));
    }
  }
  drawMoon(ctx, family, w, h, now, alt > 0);
  return ctx.getImage();
}

// Mond oben rechts: Phase und Neigung der hellen Seite wie am Himmel über dem Ort
function drawMoon(ctx, family, w, h, now, isDay) {
  const pos = moonPosition(now, C.lat, C.lon);
  if (pos.altitude < -1) return;
  const ill = moonIllumination(now);
  const r = family === 'small' ? 7 : 8.5;
  const cx = w - (family === 'small' ? 17 : 21), cy = family === 'small' ? 17 : 21;
  const glow = 14 + 12 * ill.fraction;
  for (let i = 0; i < 6; i++) {
    const g = glow * (1 - i / 6);
    ctx.setFillColor(new Color('#F4ECD8', (0.05 + 0.08 * ill.fraction) * (isDay ? 0.5 : 1)));
    ctx.fillEllipse(new Rect(cx - g, cy - g, g * 2, g * 2));
  }
  if (!isDay) { ctx.setFillColor(new Color('#0E1830', 0.92)); ctx.fillEllipse(new Rect(cx - r, cy - r, r * 2, r * 2)); }
  const f = Math.min(1, Math.max(0, ill.fraction));
  if (f < 0.01) return;
  const rot = (moonRotation(now, C.lat, C.lon) * Math.PI) / 180, cs = Math.cos(rot), sn = Math.sin(rot);
  const P = (x, y) => new Point(cx + x * cs - y * sn, cy + x * sn + y * cs);
  const k = 0.5523, ex = (f > 0.5 ? -1 : 1) * Math.abs(2 * f - 1) * r;
  const path = new Path();
  path.move(P(0, -r));
  path.addCurve(P(r, 0), P(k * r, -r), P(r, -k * r));        // heller Rand: Halbkreis
  path.addCurve(P(0, r), P(r, k * r), P(k * r, r));
  path.addCurve(P(ex, 0), P(ex * k, r), P(ex, k * r));        // Schattengrenze: Halbellipse
  path.addCurve(P(0, -r), P(ex, -k * r), P(ex * k, -r));
  path.closeSubpath();
  ctx.addPath(path);
  ctx.setFillColor(new Color('#F4ECD8', isDay ? 0.6 : 1));
  ctx.fillPath();
}

// ---------- Bausteine ----------
function text(stack, s, font, color, opts = {}) {
  const t = stack.addText(String(s));
  t.font = font; t.textColor = color;
  t.lineLimit = 1;
  t.minimumScaleFactor = opts.scale ?? 0.7;
  if (opts.opacity != null) t.textOpacity = opts.opacity;
  return t;
}
function hstack(parent, spacing = 0) { const s = parent.addStack(); s.layoutHorizontally(); s.centerAlignContent(); s.spacing = spacing; return s; }
function vstack(parent, spacing = 0) { const s = parent.addStack(); s.layoutVertically(); s.spacing = spacing; return s; }
function symbol(stack, prayer, size, color) {
  try {
    const sf = SFSymbol.named(SYMBOL[prayer] || 'moon.stars.fill');
    sf.applyFont(Font.semiboldSystemFont(size));
    const img = stack.addImage(sf.image);
    img.imageSize = new Size(size + 2, size + 2);
    img.tintColor = color;
    return img;
  } catch { return null; }
}
const rowState = (d, k) => {
  const at = d.times[k];
  const isNext = d.next && k === d.next.prayer && sameDay(d.next.date, d.D);
  return { at, isNext, passed: !isNext && Number.isFinite(at) && at <= d.now };
};

function newWidget(family, d) {
  const w = new ListWidget();
  w.backgroundGradient = (() => { const g = new LinearGradient(); g.colors = [new Color('#030A1E'), new Color('#10244C')]; g.locations = [0, 1]; return g; })();
  try { w.backgroundImage = skyImage(family, d); } catch (e) { console.log('Himmel: ' + e); }
  return w;
}

// ---------- Größen ----------
function small(d) {
  const w = newWidget('small', d);
  w.setPadding(10, 11, 9, 11);
  const head = hstack(w, 4);
  text(head, C.name || 'Athan', Font.semiboldSystemFont(11), INK2, { scale: 0.75 });
  head.addSpacer(22); // Platz für den Mond
  w.addSpacer(4);
  for (const k of ORDER) {
    const st = rowState(d, k);
    const row = hstack(w);
    row.setPadding(0.8, 5, 0.8, 5);
    if (st.isNext) { row.backgroundColor = PILL; row.cornerRadius = 6; }
    text(row, NAMES[k][0], serif(11.5, st.isNext), st.isNext ? GOLD : INK, { opacity: st.passed ? 0.5 : 1 });
    row.addSpacer();
    text(row, fmt(st.at), digits(11.5, st.isNext ? 'bold' : 'semibold'), st.isNext ? GOLD : INK, { opacity: st.passed ? 0.5 : 1 });
  }
  return w;
}

function medium(d) {
  const w = newWidget('medium', d);
  w.setPadding(12, 14, 12, 14);
  const head = hstack(w, 6);
  text(head, C.name || 'Athan', Font.semiboldSystemFont(12), INK2);
  text(head, gregText(d.now, { weekday: 'short', day: 'numeric', month: 'short' }), Font.regularSystemFont(12), INK3);
  head.addSpacer(26); // Platz für den Mond
  w.addSpacer(4);
  if (d.next) {
    const nx = hstack(w, 8);
    text(nx, shownName(d, d.next), serif(25, true), INK, { scale: 0.6 });
    text(nx, NAMES[d.next.prayer][1], arabic(15), GOLD);
    nx.addSpacer();
    const side = sideLabel(d);
    if (side) text(nx, side, Font.regularSystemFont(11), INK3);
    text(nx, fmt(d.next.at), digits(22, 'semibold'), GOLD);
  }
  w.addSpacer();
  const cols = hstack(w, 0);
  for (const k of ORDER) {
    const st = rowState(d, k);
    const col = vstack(cols, 1);
    col.setPadding(5, 1, 5, 1);
    if (st.isNext) { col.backgroundColor = PILL; col.cornerRadius = 9; }
    const op = { opacity: st.passed ? 0.48 : 1, scale: 0.55 };
    const a = hstack(col); a.addSpacer(); text(a, NAMES[k][0], serif(10.5, st.isNext), st.isNext ? GOLD : INK2, op); a.addSpacer();
    const b = hstack(col); b.addSpacer(); text(b, NAMES[k][1], arabic(9.5), GOLD, { ...op, opacity: st.passed ? 0.4 : 0.85 }); b.addSpacer();
    const c = hstack(col); c.addSpacer(); text(c, fmt(st.at), digits(13.5, st.isNext ? 'bold' : 'semibold'), st.isNext ? GOLD : INK, op); c.addSpacer();
    if (k !== 'qiyam') cols.addSpacer(2);
  }
  return w;
}

function large(d) {
  const w = newWidget('large', d);
  const sp = specialDay(d.now, C.tz, C.hijriAdj || 0);
  // kleine iPhones (SE) und Tage mit Hinweis (Ramadan, Eid …): enger setzen, damit alles Platz hat
  const tight = widgetSize('large')[1] < 345 || !!sp;
  const rowPad = tight ? 2.2 : 3.6, rowFont = tight ? 14 : 15;
  w.setPadding(15, 16, 13, 16);
  text(w, C.name || 'Athan', Font.semiboldSystemFont(13), INK2);
  w.addSpacer(2);
  text(w, gregText(d.now, { weekday: 'long', day: 'numeric', month: 'long' }), serif(16, false), INK);
  const hj = hstack(w, 8);
  text(hj, hijriText(d.now, 'de'), Font.regularSystemFont(12), INK3, { scale: 0.75 });
  text(hj, hijriText(d.now, 'ar'), arabic(13), GOLD, { opacity: 0.9, scale: 0.75 });
  if (sp) {
    w.addSpacer(5);
    const chip = hstack(w, 6);
    chip.setPadding(3, 9, 3, 9); chip.cornerRadius = 10; chip.backgroundColor = PILL;
    if (sp.kind === 'ramadan') {
      text(chip, `Ramadan · Tag ${sp.day}`, Font.mediumSystemFont(11), INK);
      text(chip, `Imsak ${fmt(d.times.imsak)} · Iftar ${fmt(d.times.maghrib)}`, digits(11, 'medium'), GOLD);
    } else {
      text(chip, sp.de, Font.mediumSystemFont(11), INK);
      text(chip, sp.ar, arabic(11), GOLD);
    }
  }
  w.addSpacer();
  if (d.next) {
    text(w, nextLabel(d), Font.regularSystemFont(11), INK3);
    const nx = hstack(w, 8);
    text(nx, shownName(d, d.next), serif(tight ? 24 : 28, true), INK, { scale: 0.6 });
    text(nx, NAMES[d.next.prayer][1], arabic(tight ? 15 : 17), GOLD);
    nx.addSpacer();
    text(nx, fmt(d.next.at), digits(tight ? 22 : 26, 'semibold'), GOLD);
  }
  w.addSpacer(tight ? 6 : 10);
  const list = vstack(w, 1);
  for (const k of ORDER) {
    const st = rowState(d, k);
    const row = hstack(list, 10);
    row.setPadding(rowPad, 8, rowPad, 8);
    if (st.isNext) { row.backgroundColor = PILL; row.cornerRadius = 8; }
    const op = { opacity: st.passed ? 0.48 : 1 };
    const nm = hstack(row); nm.size = new Size(92, 0);
    text(nm, NAMES[k][0], serif(rowFont, st.isNext), st.isNext ? GOLD : INK, op); nm.addSpacer();
    text(row, NAMES[k][1], arabic(rowFont - 2), GOLD, { opacity: st.passed ? 0.4 : 0.85 });
    row.addSpacer();
    text(row, fmt(st.at), digits(rowFont, st.isNext ? 'bold' : 'semibold'), st.isNext ? GOLD : INK, op);
  }
  return w;
}

// Sperrbildschirm (iOS färbt selbst ein). Groß das nächste Gebet mit Symbol, darunter klein das danach;
// zur Gebetszeit lädt das Widget neu und rückt eins weiter.
function lockRect(d) {
  const w = new ListWidget();
  w.setPadding(0, 2, 0, 2);
  if (!d.next) { text(w, 'Athan', Font.semiboldSystemFont(15), Color.white()); return w; }
  w.addSpacer();
  const a = hstack(w, 5);
  symbol(a, d.next.prayer, 15, Color.white());
  text(a, shownName(d, d.next), Font.boldSystemFont(22), Color.white(), { scale: 0.6 });
  a.addSpacer();
  text(a, fmt(d.next.at), Font.boldRoundedSystemFont(22), Color.white(), { scale: 0.6 });
  const n = d.after[0];
  if (n) {
    w.addSpacer(3);
    const b = hstack(w, 5);
    symbol(b, n.prayer, 11, new Color('#FFFFFF', 0.62));
    text(b, NAMES[n.prayer][0], Font.semiboldSystemFont(14), Color.white(), { opacity: 0.62 });
    b.addSpacer();
    text(b, fmt(n.at), Font.semiboldRoundedSystemFont(14), Color.white(), { opacity: 0.62 });
  }
  w.addSpacer();
  return w;
}
function lockCircle(d) {
  const w = new ListWidget();
  w.addAccessoryWidgetBackground = true;
  w.setPadding(2, 2, 2, 2);
  if (!d.next) return w;
  const s = hstack(w); s.addSpacer(); symbol(s, d.next.prayer, 11, Color.white()); s.addSpacer();
  const b = hstack(w); b.addSpacer(); text(b, fmt(d.next.at), Font.boldRoundedSystemFont(16), Color.white(), { scale: 0.6 }); b.addSpacer();
  const a = hstack(w); a.addSpacer(); text(a, shownName(d, d.next), Font.semiboldSystemFont(10), Color.white(), { scale: 0.6, opacity: 0.8 }); a.addSpacer();
  return w;
}
function lockInline(d) {
  const w = new ListWidget();
  if (!d.next) { w.addText('Athan'); return w; }
  try { const img = w.addImage(SFSymbol.named(SYMBOL[d.next.prayer] || 'moon.stars.fill').image); img.imageSize = new Size(12, 12); } catch { /* ohne Symbol */ }
  w.addText(`${shownName(d, d.next)} ${fmt(d.next.at)}`);
  return w;
}

function placeless() {
  const w = new ListWidget();
  const g = new LinearGradient(); g.colors = [new Color('#071430'), new Color('#183568')]; g.locations = [0, 1];
  w.backgroundGradient = g;
  text(w, 'Athan', serif(18, true), GOLD);
  return w;
}

function build(family, now = Date.now()) {
  if (!hasPlace()) return placeless();
  const d = dayData(now);
  let w;
  switch (family) {
    case 'medium': w = medium(d); break;
    case 'large': case 'extraLarge': w = large(d); break;
    case 'accessoryRectangular': w = lockRect(d); break;
    case 'accessoryCircular': w = lockCircle(d); break;
    case 'accessoryInline': w = lockInline(d); break;
    default: w = small(d);
  }
  // Neu zeichnen direkt nach dem nächsten Gebet. Home-Bildschirm zusätzlich für die Himmelsfarben
  // (Dämmerung alle 15 Min.); Sperrbildschirm nur zum Gebet – so bleibt iOS-Budget für pünktliches Umschalten.
  const atNext = d.next ? d.next.at + 1500 : now + 3600000;
  let when = atNext;
  if (!family.startsWith('accessory')) {
    const alt = sunAltitude(now, C.lat, C.lon);
    when = Math.min(atNext, now + (alt > -20 && alt < 14 ? 15 : 60) * 60000);
  }
  w.refreshAfterDate = new Date(Math.max(when, now + 30000));
  return w;
}

async function main() {
  const now = Date.now();
  const state = readState();
  useConfig(await loadConfig(state, now));
  if (config.runsInWidget) Script.setWidget(build(config.widgetFamily || 'small', now));
  else await build('large', now).presentLarge(); // Tippen aufs Widget öffnet die große Ansicht
  await selfUpdate(state, now);
  Script.complete();
}

await main();
