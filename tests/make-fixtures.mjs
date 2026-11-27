// Erzeugt Vergleichsdaten JS → Go (windows/testdata/fixtures.json)
import { computeDay, METHODS } from '../web/js/praytimes.js';
import { writeFileSync, mkdirSync } from 'node:fs';
const locs = [[52.52,13.405],[21.4225,39.8262],[30.0444,31.2357],[41.0082,28.9784],[-36.85,174.76],[69.65,18.96],[64.1,-21.9],[40.71,-74.0],[-33.87,151.2],[1.35,103.82],[33.51,36.29],[48.14,11.58],[59.33,18.07],[-54.8,-68.3],[0,0]];
const out = [];
let i = 0;
for (const [lat, lon] of locs) for (const method of Object.keys(METHODS)) for (const highLat of ['angle','seventh','middle','none']) {
  for (const [y,m,d] of [[2026,1,15],[2026,3,20],[2026,6,21],[2026,9,23],[2026,11,27],[2027,2,10],[2026,2,20]]) {
    const asr = (i++ % 2) ? 'hanafi' : 'standard';
    const calc = { method, asr, highLat, adjust: { fajr: (i%3)-1, isha: (i%5)-2 }, custom: { fajr: 17.5, isha: 16, ishaMin: (i%4===0)?75:0, maghribMin: (i%6===0)?3:0 } };
    const t = computeDay({y,m,d}, {lat, lon}, calc);
    const res = {}; for (const k in t) res[k] = isFinite(t[k]) ? t[k] : 0;
    out.push({ date: {Y:y,M:m,D:d}, lat, lon, calc, res });
  }
}
mkdirSync('windows/testdata', { recursive: true });
writeFileSync('windows/testdata/fixtures.json', JSON.stringify(out));
console.log('fixtures', out.length);
