// ---------- Widget (Scriptable) ----------
// Klein: alle Zeiten als Liste · Mittel: nächstes Gebet + alle Zeiten · Groß: dazu Datum, Hidschri, Mond
// Sperrbildschirm: groß das nächste Gebet, klein das danach · rund · als Zeile über der Uhr.
// Rechnet auf dem iPhone ohne Internet. Mit Internet: übernimmt Ort/Einstellungen aus der Athan-App
// (stündlich) und aktualisiert sich selbst, wenn es eine neue Version gibt (zweimal am Tag).

let C = CONFIG;
const DAY = 86400000;
const NOW_WINDOW = 20 * 60000;
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
  // Die ersten 20 Minuten nach einem Gebet: „jetzt“ (mit Kaaba) statt schon das nächste
  const current = upcomingEvents(loc, C.calc, now - NOW_WINDOW, 1).find((e) => e.prayer !== 'sunrise' && e.at <= now && e.at > now - NOW_WINDOW) || null;
  // Angezeigt wird der Tag des Gebets im Blick – nach Isha also schon morgen
  const D = current ? current.date : next ? next.date : today;
  const t = computeDay(D, loc, C.calc);
  const prev = computeDay(addDays(D, -1), loc, C.calc);
  const tt = sameDay(D, today) ? t : computeDay(today, loc, C.calc);
  // Qiyam: Beginn des letzten Nachtdrittels – vor Fajr die laufende Nacht, danach die kommende
  const times = { ...t, qiyam: now < t.fajr ? prev.lastThird : t.lastThird };
  const focus = current || next;
  const after = focus ? events.filter((e) => e.at > focus.at).slice(0, 2) : [];
  const hNext = focus ? hijriParts(focus.at, C.tz, C.hijriAdj || 0) : null;
  return { now, today, D, t, tt, times, next: focus, isNow: !!current, upcoming: next, after, tomorrow: !sameDay(D, today), ramadanNext: hNext?.m === 9 };
}

// Name für eine Zeile – im Ramadan heißt Maghrib „Iftar“
const shownName = (d, e) => (d.ramadanNext && e === d.next && e.prayer === 'maghrib' ? 'Iftar' : NAMES[e.prayer][0]);

function nextLabel(d) {
  if (!d.next) return '';
  if (d.isNow) return 'Jetzt ist Gebetszeit';
  const p = d.next.prayer;
  if (p === 'sunrise') return 'Fajr-Zeit endet';
  if (d.ramadanNext && p === 'maghrib') return 'Fastenbrechen';
  if (d.ramadanNext && p === 'fajr') return 'Suhoor endet';
  return d.tomorrow ? 'Nächstes Gebet, morgen' : 'Nächstes Gebet';
}
// kurzer Hinweis neben der Uhrzeit (nur wenn er etwas sagt)
function sideLabel(d) {
  if (d.isNow) return '';
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
  if (d.isNow) drawMakkah(ctx, family, w, h);
  return ctx.getImage();
}

// Zur Gebetszeit: Mekka am Horizont – Uhrturm, Minarette und Kaaba als Schattenriss mit goldenem Schein
function drawMakkah(ctx, family, w, h) {
  const H = h * (family === 'large' ? 0.36 : family === 'small' ? 0.55 : 0.7), base = h, cx = w * (family === 'small' ? 0.62 : 0.8), u = H / 100;
  for (let i = 0; i < 10; i++) { // Schein hinter dem Turm
    const k = 1 - i / 10, rx = H * 0.9 * k, ry = H * 0.75 * k;
    ctx.setFillColor(new Color('#E8C27A', 0.035));
    ctx.fillEllipse(new Rect(cx - rx, base - H * 0.55 - ry, rx * 2, ry * 2));
  }
  const dark = new Color('#040916', 0.72);
  const rect = (x, y, rw, rh) => { ctx.setFillColor(dark); ctx.fillRect(new Rect(x, y, rw, rh)); };
  const spire = (x, top, wd) => { const p = new Path(); p.move(new Point(x - wd, base)); p.addLine(new Point(x - wd, top + wd * 4)); p.addLine(new Point(x, top)); p.addLine(new Point(x + wd, top + wd * 4)); p.addLine(new Point(x + wd, base)); p.closeSubpath(); ctx.addPath(p); ctx.setFillColor(dark); ctx.fillPath(); };
  // Uhrturm
  rect(cx - 9 * u, base - 58 * u, 18 * u, 58 * u);
  rect(cx - 6.5 * u, base - 72 * u, 13 * u, 15 * u);
  rect(cx - 4.5 * u, base - 80 * u, 9 * u, 9 * u);
  spire(cx, base - 100 * u, 1.2 * u);
  ctx.setFillColor(new Color('#F3DBA4', 0.4)); ctx.fillEllipse(new Rect(cx - 4.2 * u, base - 69.5 * u, 8.4 * u, 8.4 * u)); // Uhr
  ctx.setFillColor(new Color('#F3DBA4', 0.9)); ctx.fillEllipse(new Rect(cx - 1.4 * u, base - 103 * u, 2.8 * u, 2.8 * u)); // Mondsichel oben
  // Nebentürme und Minarette
  rect(cx - 21 * u, base - 36 * u, 10 * u, 36 * u);
  rect(cx + 11 * u, base - 32 * u, 10 * u, 32 * u);
  spire(cx - 30 * u, base - 52 * u, 1.3 * u);
  spire(cx + 27 * u, base - 48 * u, 1.3 * u);
  // Kaaba davor, mit goldenem Band
  const kx = cx - 48 * u, kw = 15 * u;
  rect(kx, base - 14 * u, kw, 14 * u);
  ctx.setFillColor(new Color('#D8B26E', 0.9)); ctx.fillRect(new Rect(kx, base - 11.5 * u, kw, 1.6 * u));
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

// ---------- Logo (wie das App-Symbol: Achtstern mit Mondsichel; im Ramadan eine Laterne) ----------
const CRESCENT = [0.6277,0.5297,0.6248,0.544,0.6203,0.5579,0.6143,0.5712,0.6069,0.5838,0.598,0.5954,0.5879,0.606,0.5767,0.6153,0.5645,0.6234,0.5514,0.6299,0.5377,0.635,0.5235,0.6385,0.509,0.6403,0.4944,0.6405,0.4798,0.639,0.4656,0.6359,0.4517,0.6312,0.4385,0.625,0.4261,0.6173,0.4146,0.6083,0.4042,0.598,0.3951,0.5866,0.3873,0.5742,0.3809,0.561,0.3761,0.5473,0.3729,0.533,0.3713,0.5185,0.3713,0.5038,0.3731,0.4893,0.3764,0.4751,0.3813,0.4614,0.3878,0.4482,0.3957,0.4359,0.405,0.4246,0.4154,0.4144,0.427,0.4055,0.4395,0.3979,0.4528,0.3918,0.453,0.3918,0.4468,0.4016,0.4416,0.4121,0.4375,0.423,0.4346,0.4343,0.4328,0.4458,0.4323,0.4574,0.433,0.4691,0.435,0.4806,0.4381,0.4918,0.4424,0.5026,0.4477,0.513,0.4542,0.5227,0.4616,0.5317,0.4699,0.5398,0.479,0.5471,0.4888,0.5534,0.4993,0.5586,0.5102,0.5626,0.5215,0.5656,0.533,0.5673,0.5446,0.5678,0.5563,0.5671,0.5678,0.5652,0.579,0.562,0.5898,0.5578,0.6002,0.5524,0.6099,0.546,0.6189,0.5385,0.627,0.5302]; // Mondsichel aus icons/icon.svg, Koordinaten 0–1
function logoImage(ramadan, pt = 22) {
  const px = pt * 3, ctx = new DrawContext();
  ctx.size = new Size(px, px); ctx.opaque = false; ctx.respectScreenScale = false;
  const gold = new Color('#D8B26E'), light = new Color('#F3DBA4');
  const poly = (pts, close = true) => { const p = new Path(); pts.forEach((q, i) => (i ? p.addLine(q) : p.move(q))); if (close) p.closeSubpath(); return p; };
  const crescent = (cx, cy, size) => { // size = Breite des 512er-Symbols
    const pts = [];
    for (let i = 0; i < CRESCENT.length; i += 2) pts.push(new Point(cx + (CRESCENT[i] - 0.5) * size, cy + (CRESCENT[i + 1] - 0.512) * size));
    ctx.addPath(poly(pts)); ctx.setFillColor(light); ctx.fillPath();
  };
  if (!ramadan) {
    const k = px / 512;
    ctx.setStrokeColor(gold); ctx.setLineWidth(Math.max(2.2, 17 * k * 1.25));
    for (const off of [Math.PI / 4, 0]) { // zwei Quadrate → Achtstern
      const r = 122 * Math.SQRT2 * k, pts = [];
      for (let i = 0; i < 4; i++) { const a = off + i * Math.PI / 2; pts.push(new Point(256 * k + r * Math.cos(a), 262 * k + r * Math.sin(a))); }
      ctx.addPath(poly(pts)); ctx.strokePath();
    }
    crescent(px / 2, px / 2, px);
    ctx.setFillColor(light); ctx.fillEllipse(new Rect(291 * k, 209 * k, 18 * k, 18 * k));
  } else {
    // Ramadan-Laterne (wie in der App) mit Mondsichel
    const s = (px * 0.94) / 118, ox = px * 0.36 - 20 * s, oy = px * 0.03;
    const L = (x, y) => new Point(ox + x * s, oy + y * s);
    ctx.setStrokeColor(gold); ctx.setLineWidth(Math.max(1.6, 1.4 * s));
    ctx.addPath(poly([L(20, 0), L(20, 24)], false)); ctx.strokePath();
    ctx.addPath(poly([L(13.5, 24), L(26.5, 24), L(24.3, 30.5), L(15.7, 30.5)])); ctx.setFillColor(gold); ctx.fillPath();
    const body = [L(11, 30.5), L(29, 30.5), L(35, 44.5), L(35, 72.5), L(29, 83.5), L(11, 83.5), L(5, 72.5), L(5, 44.5)];
    ctx.addPath(poly(body)); ctx.setFillColor(new Color('#FFC46E', 0.16)); ctx.fillPath();
    ctx.addPath(poly(body)); ctx.strokePath();
    ctx.setFillColor(new Color('#FFD48A', 0.6)); ctx.fillEllipse(new Rect(ox + 12.5 * s, oy + 47 * s, 15 * s, 22 * s));
    ctx.setFillColor(new Color('#FFF1CC', 0.95)); ctx.fillEllipse(new Rect(ox + 16.8 * s, oy + 52.5 * s, 6.4 * s, 11 * s));
    ctx.addPath(poly([L(14, 83.5), L(26, 83.5), L(23.4, 90), L(16.6, 90)])); ctx.setFillColor(gold); ctx.fillPath();
    ctx.addPath(poly([L(20, 90), L(20, 99)], false)); ctx.strokePath();
    ctx.fillEllipse(new Rect(ox + 17.6 * s, oy + 99.6 * s, 4.8 * s, 4.8 * s));
    crescent(px * 0.74, px * 0.3, px * 1.05);
  }
  return ctx.getImage();
}
// Kaaba als kleines Zeichen (für „jetzt“)
function kaabaImage(pt, color) {
  const px = pt * 3, ctx = new DrawContext();
  ctx.size = new Size(px, px); ctx.opaque = false; ctx.respectScreenScale = false;
  const k = px / 24, P = (x, y) => new Point(x * k, y * k);
  const body = new Path();
  [P(4, 8), P(12, 4.5), P(20, 8), P(20, 17.5), P(12, 21), P(4, 17.5)].forEach((q, i) => (i ? body.addLine(q) : body.move(q)));
  body.closeSubpath();
  ctx.addPath(body); ctx.setFillColor(color); ctx.fillPath();
  const band = new Path(); band.move(P(4, 10.6)); band.addLine(P(12, 14)); band.addLine(P(20, 10.6));
  ctx.addPath(band); ctx.setStrokeColor(new Color('#D8B26E')); ctx.setLineWidth(1.6 * k); ctx.strokePath();
  return ctx.getImage();
}
function kaaba(stack, pt, color) {
  try { const img = stack.addImage(kaabaImage(pt, color)); img.imageSize = new Size(pt, pt); return img; } catch { return null; }
}

const isRamadanNow = (d) => hijriParts(d.now, C.tz, C.hijriAdj || 0).m === 9;
function logo(stack, d, pt) {
  try { const img = stack.addImage(logoImage(isRamadanNow(d), pt)); img.imageSize = new Size(pt, pt); return img; } catch { return null; }
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
  const head = hstack(w, 5);
  logo(head, d, 14);
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
  logo(head, d, 16);
  text(head, C.name || 'Athan', Font.semiboldSystemFont(12), INK2);
  text(head, gregText(d.now, { weekday: 'short', day: 'numeric', month: 'short' }), Font.regularSystemFont(12), INK3);
  head.addSpacer(26); // Platz für den Mond
  w.addSpacer(4);
  if (d.next) {
    const nx = hstack(w, 8);
    if (d.isNow) kaaba(nx, 17, INK);
    text(nx, shownName(d, d.next), serif(20, true), INK, { scale: 0.6 });
    text(nx, NAMES[d.next.prayer][1], arabic(13), GOLD);
    nx.addSpacer();
    const side = sideLabel(d);
    if (side) text(nx, side, Font.regularSystemFont(10.5), INK3);
    text(nx, d.isNow ? 'jetzt' : fmt(d.next.at), digits(17, 'semibold'), GOLD);
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
    const c = hstack(col); c.addSpacer(); text(c, fmt(st.at), digits(12.5, st.isNext ? 'bold' : 'semibold'), st.isNext ? GOLD : INK, op); c.addSpacer();
    if (k !== 'qiyam') cols.addSpacer(2);
  }
  return w;
}

function large(d) {
  const w = newWidget('large', d);
  const sp = specialDay(d.now, C.tz, C.hijriAdj || 0);
  // kleine iPhones (SE) und Tage mit Hinweis (Ramadan, Eid …): enger setzen, damit alles Platz hat
  const tight = widgetSize('large')[1] < 345 || !!sp;
  const rowPad = tight ? 2.4 : 3.8, rowFont = tight ? 13 : 14;
  w.setPadding(15, 16, 13, 16);
  const head = hstack(w, 7);
  logo(head, d, 20);
  text(head, C.name || 'Athan', Font.semiboldSystemFont(13), INK2);
  w.addSpacer(3);
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
    if (d.isNow) kaaba(nx, tight ? 18 : 20, INK);
    text(nx, shownName(d, d.next), serif(tight ? 20 : 23, true), INK, { scale: 0.6 });
    text(nx, NAMES[d.next.prayer][1], arabic(tight ? 13 : 15), GOLD);
    nx.addSpacer();
    text(nx, d.isNow ? 'jetzt' : fmt(d.next.at), digits(tight ? 18 : 21, 'semibold'), GOLD);
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
  if (d.isNow) kaaba(a, 15, Color.white()); else symbol(a, d.next.prayer, 13, Color.white());
  text(a, shownName(d, d.next), Font.boldSystemFont(18), Color.white(), { scale: 0.6 });
  a.addSpacer();
  text(a, d.isNow ? 'jetzt' : fmt(d.next.at), Font.boldRoundedSystemFont(18), Color.white(), { scale: 0.6 });
  const n = d.after[0];
  if (n) {
    w.addSpacer(3);
    const b = hstack(w, 5);
    symbol(b, n.prayer, 10, new Color('#FFFFFF', 0.62));
    text(b, NAMES[n.prayer][0], Font.semiboldSystemFont(13), Color.white(), { opacity: 0.62 });
    b.addSpacer();
    text(b, fmt(n.at), Font.semiboldRoundedSystemFont(13), Color.white(), { opacity: 0.62 });
  }
  w.addSpacer();
  return w;
}
function lockCircle(d) {
  const w = new ListWidget();
  w.addAccessoryWidgetBackground = true;
  w.setPadding(2, 2, 2, 2);
  if (!d.next) return w;
  const s = hstack(w); s.addSpacer(); if (d.isNow) kaaba(s, 13, Color.white()); else symbol(s, d.next.prayer, 11, Color.white()); s.addSpacer();
  const b = hstack(w); b.addSpacer(); text(b, d.isNow ? 'jetzt' : fmt(d.next.at), Font.boldRoundedSystemFont(15), Color.white(), { scale: 0.6 }); b.addSpacer();
  const a = hstack(w); a.addSpacer(); text(a, shownName(d, d.next), Font.semiboldSystemFont(10), Color.white(), { scale: 0.6, opacity: 0.8 }); a.addSpacer();
  return w;
}
function lockInline(d) {
  const w = new ListWidget();
  if (!d.next) { w.addText('Athan'); return w; }
  try { const img = w.addImage(SFSymbol.named(SYMBOL[d.next.prayer] || 'moon.stars.fill').image); img.imageSize = new Size(12, 12); } catch { /* ohne Symbol */ }
  w.addText(d.isNow ? `${shownName(d, d.next)} · jetzt` : `${shownName(d, d.next)} ${fmt(d.next.at)}`);
  return w;
}

function placeless() {
  const w = new ListWidget();
  const g = new LinearGradient(); g.colors = [new Color('#071430'), new Color('#183568')]; g.locations = [0, 1];
  w.backgroundGradient = g;
  const h = hstack(w, 8);
  try { const img = h.addImage(logoImage(false, 26)); img.imageSize = new Size(26, 26); } catch { /* ohne Logo */ }
  text(h, 'Athan', serif(18, true), GOLD);
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
  const atNext = d.isNow ? Math.min(d.next.at + NOW_WINDOW + 1500, d.upcoming ? d.upcoming.at + 1500 : Infinity) : d.next ? d.next.at + 1500 : now + 3600000;
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
