// Gebetszeiten-Engine – astronomische Berechnung (nach dem PrayTimes.org-Verfahren)
// Läuft im Browser, im Service Worker und in Node (Push-Server). Keine Abhängigkeiten.

export const KAABA = { lat: 21.422487, lon: 39.826206 };

// Berechnungsmethoden: Winkel in Grad, *_min = Minuten nach Maghrib/Sonnenuntergang
export const METHODS = {
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

export function suggestMethod(countryCode) {
  const cc = (countryCode || '').toUpperCase();
  return { method: COUNTRY_METHOD[cc] || 'MWL', asr: HANAFI_COUNTRIES.has(cc) ? 'hanafi' : 'standard' };
}

export const PRAYERS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

export const DEFAULT_CALC = {
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
export function hijriArithmetic(y, m, d) {
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
export function computeDay(date, coords, calc) {
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
export function zonedParts(epoch, tz) {
  const parts = {};
  for (const p of dtf(tz).formatToParts(new Date(epoch))) parts[p.type] = p.value;
  return {
    y: +parts.year, m: +parts.month, d: +parts.day,
    h: +parts.hour % 24, min: +parts.minute, s: +parts.second, wd: parts.weekday,
  };
}
export function isValidTimeZone(tz) {
  try { dtf(tz); return true; } catch { return false; }
}
export function addDays({ y, m, d }, n) {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Liste der kommenden Ereignisse (Gebete) ab `from` für `days` Tage am Ort. */
export function upcomingEvents(location, calc, from = Date.now(), days = 2) {
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
export function qiblaBearing(lat, lon) {
  const p1 = lat * DEG, p2 = KAABA.lat * DEG, dl = (KAABA.lon - lon) * DEG;
  const b = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
  return fixAngle(b / DEG);
}
export function distanceToKaabaKm(lat, lon) {
  const R = 6371.0088;
  const p1 = lat * DEG, p2 = KAABA.lat * DEG;
  const dp = (KAABA.lat - lat) * DEG, dl = (KAABA.lon - lon) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Sonnenhöhe (Grad) zu einem Zeitpunkt – für den Himmelsverlauf im UI
export function sunAltitude(epoch, lat, lon) {
  const jd = epoch / 86400000 + 2440587.5;
  const { decl, eqt } = sunPosition(jd);
  const utcH = ((epoch / 3600000) % 24 + 24) % 24;
  const solarH = utcH + lon / 15 + eqt;
  const ha = (solarH - 12) * 15;
  return darcsin(dsin(lat) * dsin(decl) + dcos(lat) * dcos(decl) * dcos(ha));
}
