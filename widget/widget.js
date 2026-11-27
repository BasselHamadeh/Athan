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
