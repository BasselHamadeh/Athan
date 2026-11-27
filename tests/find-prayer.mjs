// Findet einen Längengrad, an dem in 75–135 Sekunden ein Gebet fällig ist (für den Windows-Funktionstest).
import { computeDay } from '../web/js/praytimes.js';

const now = Date.now();
const d = new Date(now);
const date = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
for (let x = -179; x <= 179; x += 0.005) {
  const t = computeDay(date, { lat: 25, lon: x }, { method: 'MWL' });
  for (const k of ['dhuhr', 'asr', 'maghrib', 'isha', 'fajr']) {
    if (t[k] >= now + 75000 && t[k] <= now + 135000) {
      console.log(JSON.stringify({ lon: +x.toFixed(3), prayer: k, at: t[k] }));
      process.exit(0);
    }
  }
}
console.error('kein passender Ort gefunden');
process.exit(1);
