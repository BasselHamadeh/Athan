// Himmelsfarben nach Sonnenhöhe – gemeinsam für die App und das iPhone-Widget.
// Zwei Verläufe: Morgen (Fajr → Shuruq → Vormittag) und Abend (Asr → Maghrib → Isha).

export const NIGHT = { top: '#01040C', mid: '#030916', low: '#07112A', glow: [40, 60, 140, 0], stars: 1 };
export const NOON = { top: '#0C467E', mid: '#18659C', low: '#24709C', glow: [255, 245, 210, 0.10], stars: 0 };
export const MORNING = [
  { a: -90, ...NIGHT },
  { a: -18, top: '#030A1E', mid: '#081633', low: '#10244C', glow: [90, 80, 160, 0.08], stars: 0.95 },
  { a: -12, top: '#0B1440', mid: '#1E225A', low: '#3A2F68', glow: [180, 120, 190, 0.22], stars: 0.6 },
  { a: -5, top: '#141C52', mid: '#3A2F6A', low: '#6A4272', glow: [236, 150, 150, 0.32], stars: 0.2 },
  { a: 2, top: '#1B2E66', mid: '#4A4A80', low: '#7A5068', glow: [250, 175, 120, 0.40], stars: 0 },
  { a: 12, top: '#143C70', mid: '#2B5A8A', low: '#3F6A8A', glow: [255, 215, 150, 0.22], stars: 0 },
  { a: 35, top: '#0E447A', mid: '#1B6296', low: '#2A6E98', glow: [255, 240, 200, 0.12], stars: 0 },
  { a: 90, ...NOON },
];
export const EVENING = [
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
export function skyAt(alt, evening) {
  const KF = evening ? EVENING : MORNING;
  let i = KF.findIndex((k) => k.a >= alt); if (i <= 0) i = 1;
  const a = KF[i - 1], b = KF[i], t = Math.min(1, Math.max(0, (alt - a.a) / (b.a - a.a)));
  return {
    top: mixRGB(a.top, b.top, t), mid: mixRGB(a.mid, b.mid, t), low: mixRGB(a.low, b.low, t),
    glow: a.glow.map((v, k) => lerp(v, b.glow[k], t)), stars: lerp(a.stars, b.stars, t),
  };
}
