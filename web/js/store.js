// Einstellungen – lokal im Browser (und in der Windows-App zusätzlich in %APPDATA%)
import { DEFAULT_CALC } from './praytimes.js';

const KEY = 'athan.settings.v1';

export const DEFAULTS = {
  v: 1,
  location: null,            // { name, region, country, cc, lat, lon, tz }
  calc: structuredClone(DEFAULT_CALC),
  methodAuto: true,          // Methode passend zum Land vorschlagen
  voice: 'makkah_mulla',
  fajrVoice: 'auto',         // 'auto' = passender Fajr-Athan zur Stimme
  volume: 0.9,
  modes: { fajr: 'athan', sunrise: 'off', dhuhr: 'athan', asr: 'athan', maghrib: 'athan', isha: 'athan' },
  pre: 0,                    // Minuten vorher erinnern
  clock: '24',
  openOnAthan: false,        // nur Windows
  hijriAdj: 0,               // Hidschri-Datum: -1, 0, +1 Tag
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') out[k] = merge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

export function sanitize(s) {
  const o = merge(DEFAULTS, s);
  if (o.location) {
    const l = o.location;
    const lat = +l.lat, lon = +l.lon;
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) o.location = null;
    else o.location = { name: String(l.name || '').slice(0, 80), region: String(l.region || '').slice(0, 80), country: String(l.country || '').slice(0, 60), cc: String(l.cc || '').slice(0, 2).toUpperCase(), lat, lon, tz: String(l.tz || 'UTC').slice(0, 64) };
  }
  o.volume = Math.min(1, Math.max(0, +o.volume || 0));
  o.pre = [0, 5, 10, 15, 20, 30].includes(+o.pre) ? +o.pre : 0;
  o.hijriAdj = [-1, 0, 1].includes(+o.hijriAdj) ? +o.hijriAdj : 0;
  for (const k of Object.keys(DEFAULTS.modes)) if (!['athan', 'notify', 'off'].includes(o.modes[k])) o.modes[k] = DEFAULTS.modes[k];
  for (const k of Object.keys(DEFAULT_CALC.adjust)) o.calc.adjust[k] = Math.max(-60, Math.min(60, Math.round(+o.calc.adjust[k] || 0)));
  return o;
}

export function loadLocal() {
  try { return sanitize(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return sanitize(null); }
}
export function saveLocal(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* privater Modus */ }
}
