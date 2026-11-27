// Baut den Widget-Code für Scriptable (eine Datei, ohne Module): Gebetszeiten, Hidschri, Mond und Himmelsfarben
// kommen unverändert aus der App, damit Widget und App immer gleich rechnen.
//   node scripts/build-widget.mjs          → web/widget/athan-widget.js schreiben
//   node scripts/build-widget.mjs --check  → Fehler, wenn die Datei nicht zum Quellcode passt (CI)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const MODULES = ['praytimes', 'hijri', 'astro', 'palette'];
const USE = {
  praytimes: ['computeDay', 'upcomingEvents', 'zonedParts', 'addDays', 'sunAltitude'],
  hijri: ['hijriParts', 'specialDay'],
  astro: ['moonPosition', 'moonIllumination', 'moonRotation'],
  palette: ['skyAt'],
};

function wrap(name) {
  let src = read(`web/js/${name}.js`);
  const exported = [...src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  src = src.replace(/^import\s*\{([^}]+)\}\s*from\s*'\.\/([\w-]+)\.js';\s*$/gm, (_, names, mod) => `const {${names}} = M_${mod};`);
  if (/^\s*import\s/m.test(src)) throw new Error(`${name}: unbekannter Import`);
  src = src.replace(/^export\s+/gm, '');
  return `// ---- ${name}.js ----\nconst M_${name} = (() => {\n${src.trim()}\nreturn { ${exported.join(', ')} };\n})();\n`;
}

const version = /VERSION = '([\d.]+)'/.exec(read('web/js/app.js'))[1];
const out = [
  `// Athan-Widget für Scriptable (iPhone) – Version ${version}`,
  '// https://github.com/BasselHamadeh/Athan · keine Werbung, kein Tracking, rechnet ohne Internet.',
  '// Den Code bitte nicht von Hand ändern: In der Athan-App unter Einstellungen → iPhone → „Widget-Code kopieren“',
  '// bekommst du ihn mit deinem Ort und deinen Einstellungen.',
  '',
  `const CONFIG = /*CONFIG*/${JSON.stringify({ name: '', lat: null, lon: null, tz: '', calc: { method: 'MWL', asr: 'standard', highLat: 'angle', adjust: {} }, clock: '24', hijriAdj: 0 })}/*END*/;`,
  '',
  ...MODULES.map(wrap),
  ...MODULES.map((m) => `const { ${USE[m].join(', ')} } = M_${m};`),
  '',
  read('widget/widget.js').trim(),
  '',
].join('\n');

const target = new URL('web/widget/athan-widget.js', root);
if (process.argv.includes('--check')) {
  const cur = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (cur !== out) { console.error('web/widget/athan-widget.js ist veraltet – bitte node scripts/build-widget.mjs ausführen'); process.exit(1); }
  console.log('Widget-Code aktuell');
} else {
  mkdirSync(new URL('web/widget/', root), { recursive: true });
  writeFileSync(target, out);
  console.log(`web/widget/athan-widget.js geschrieben (${(out.length / 1024).toFixed(1)} KB)`);
}
