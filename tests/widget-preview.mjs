// Vorschau des iPhone-Widgets als HTML (zum Ansehen/Screenshot): node tests/widget-preview.mjs out.html
import { writeFileSync } from 'node:fs';
import { run, loadCode, toHTML, SIZES } from './scriptable-mock.mjs';
import { zonedParts } from '../web/js/praytimes.js';

const cfg = { name: 'Saarbrücken', lat: 49.2402, lon: 6.9969, tz: 'Europe/Berlin', calc: { method: 'MWL', asr: 'standard', highLat: 'angle', adjust: {} }, clock: '24', hijriAdj: 0 };
const berlin = (y, m, d, h, min) => { const g = Date.UTC(y, m - 1, d, h, min); const p = zonedParts(g, cfg.tz); return g - (Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - g); };
const code = loadCode();
// SE=1: kleinstes iPhone (375 × 667) – Widgets 148 / 321 × 148 / 321 × 324
const SE = process.env.SE === '1';
if (SE) Object.assign(SIZES, { small: [148, 148], medium: [321, 148], large: [321, 324] });
const screen = SE ? [375, 667] : [390, 844];
const scenes = (process.env.SCENES || 'night,sunset,day,dawn,ramadan').split(',');
const TIMES = {
  night: ['Freitag 19:10 (jetzt)', berlin(2026, 11, 27, 19, 10)],
  sunset: ['Freitag 16:42 (Maghrib)', berlin(2026, 11, 27, 16, 42)],
  day: ['Freitag 12:05', berlin(2026, 11, 27, 12, 5)],
  dawn: ['Samstag 07:40', berlin(2026, 11, 28, 7, 40)],
  ramadan: ['Ramadan, 20.2.2027 17:00', berlin(2027, 2, 20, 17, 0)],
  fullmoon: ['Vollmond 24.12.2026 21:00', berlin(2026, 12, 24, 21, 0)],
  isha: ['Isha-Zeit (jetzt)', berlin(2026, 11, 27, 18, 30)],
};
let html = '';
for (const s of scenes) {
  const [label, now] = TIMES[s];
  const cells = [];
  for (const f of ['small', 'medium', 'large']) cells.push(toHTML((await run(code, { family: f, now, cfg, screen })).widget, f, now));
  const lock = [];
  for (const f of ['accessoryInline', 'accessoryRectangular', 'accessoryCircular']) lock.push(toHTML((await run(code, { family: f, now, cfg })).widget, f, now));
  html += `<section><h2>${label}</h2><div class="row">${cells.join('')}<div class="lock">${lock.join('')}</div></div></section>`;
}
writeFileSync(process.argv[2] || 'widget-preview.html', `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:24px;background:linear-gradient(160deg,#3a4a6a,#a88b7a);font-family:-apple-system,Helvetica,Arial,sans-serif;color:#fff}
h2{font:600 14px Helvetica,Arial;margin:18px 0 8px;opacity:.85}
.row{display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap}
.widget{position:relative;overflow:hidden;box-shadow:0 6px 20px rgba(0,0,0,.35);flex:none}
.widget .bg,.widget .bg svg{position:absolute;inset:0;width:100%;height:100%}
.widget .content{position:relative;box-sizing:border-box;height:100%;display:flex;flex-direction:column;justify-content:center;overflow:hidden}
.t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;min-width:0}
.lock{display:flex;flex-direction:column;gap:12px;padding:12px;border-radius:16px;background:rgba(0,0,0,.25)}
.over{outline:1px solid red}
</style>${html}<script>
// Texte, die abgeschnitten würden: Scriptable verkleinert bis minimumScaleFactor – rot markieren, wenn auch das nicht reicht
for (const el of document.querySelectorAll('.t')) { const need = el.scrollWidth / el.clientWidth; if (need > 1.01 && need > 1 / (+el.dataset.scale || 1)) el.classList.add('over'); }
let tall = 0;
for (const c of document.querySelectorAll('.content')) if (c.scrollHeight > c.clientHeight + 1) { c.parentElement.style.outline = '2px solid red'; tall++; }
document.title = 'over=' + document.querySelectorAll('.over').length + ' tall=' + tall;
</script>`);
console.log('Vorschau geschrieben');
