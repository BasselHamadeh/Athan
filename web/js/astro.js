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
export function moonPosition(ms, lat, lon) {
  const lw = rad * -lon, phi = rad * lat, d = toDays(ms);
  const c = moonCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  const h = altitudeOf(H, phi, c.dec);
  const pa = Math.atan2(Math.sin(H), Math.tan(phi) * Math.cos(c.dec) - Math.sin(c.dec) * Math.cos(H));
  return { azimuth: azimuthOf(H, phi, c.dec) / rad, altitude: (h + refraction(h)) / rad, parallacticAngle: pa };
}

/** Beleuchteter Anteil (0–1), Phase (0 Neumond, 0,5 Vollmond) und Richtung der hellen Seite (Radiant). */
export function moonIllumination(ms) {
  const d = toDays(ms), s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / PI, angle };
}

/** SVG-Pfad des beleuchteten Teils (Mittelpunkt 0,0) – helle Seite zeigt nach rechts, danach drehen. */
export function moonLitPath(fraction, r) {
  const f = Math.min(1, Math.max(0, fraction));
  const rx = Math.abs(2 * f - 1) * r;
  return `M0 ${-r} A${r} ${r} 0 0 1 0 ${r} A${rx.toFixed(2)} ${r} 0 0 ${f > 0.5 ? 1 : 0} 0 ${-r} Z`;
}

/** Drehung (Grad, im Uhrzeigersinn) für die helle Seite, aus Sicht des Betrachters. */
export function moonRotation(ms, lat, lon) {
  const z = moonIllumination(ms).angle - moonPosition(ms, lat, lon).parallacticAngle;
  return -z / rad - 90;
}
