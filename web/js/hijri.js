// Islamischer Kalender (Umm al-Qura) mit Tagesanpassung ±1, Ramadan und besondere Tage.
import { hijriArithmetic } from './praytimes.js';

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
export function hijriParts(epoch, tz, adj = 0) {
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

export const isRamadan = (epoch, tz, adj = 0) => hijriParts(epoch, tz, adj).m === 9;

/** Tage bis zum 1. Ramadan (0 = heute ist Ramadan), höchstens `max`, sonst null. */
export function daysUntilRamadan(epoch, tz, adj = 0, max = 60) {
  for (let i = 0; i <= max; i++) {
    const h = hijriParts(epoch + i * DAY, tz, adj);
    if (h.m === 9) return i === 0 ? (h.d === 1 ? 0 : -h.d + 1) : i;
  }
  return null;
}

/** Besonderer Tag (oder null): { de, ar, kind } – kind steuert die Gestaltung. */
export function specialDay(epoch, tz, adj = 0) {
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
export function moonPhaseName(phase) {
  return PHASES[Math.round(((phase % 1) + 1) % 1 * 8) % 8];
}
