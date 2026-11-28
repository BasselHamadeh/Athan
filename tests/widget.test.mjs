// Testet das iPhone-Widget (Scriptable) mit nachgebauter Scriptable-API: alle Größen, Tageszeiten,
// Freitag (Dhuhr), Qiyam, Ramadan, Vorschau in der App und Einrichtungs-Hinweis.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { run, loadCode, texts, highlighted, SIZES } from './scriptable-mock.mjs';
import { computeDay, addDays, zonedParts, upcomingEvents } from '../web/js/praytimes.js';

let failed = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' – ' + extra : ''}`); if (!cond) failed++; };

execFileSync(process.execPath, [new URL('../scripts/build-widget.mjs', import.meta.url).pathname, '--check'], { stdio: 'inherit' });
const code = loadCode();
const cfg = { name: 'Saarbrücken', lat: 49.2402, lon: 6.9969, tz: 'Europe/Berlin', calc: { method: 'MWL', asr: 'standard', highLat: 'angle', adjust: { fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 } }, clock: '24', hijriAdj: 0 };
const loc = { lat: cfg.lat, lon: cfg.lon, tz: cfg.tz };
const fmt = (ms) => new Intl.DateTimeFormat('de-DE', { timeZone: cfg.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
const berlin = (y, m, d, h, min) => { // Ortszeit Berlin → Epoche
  const guess = Date.UTC(y, m - 1, d, h, min);
  const p = zonedParts(guess, cfg.tz);
  return guess - (Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - guess);
};
const NAMES = ['Fajr', 'Shuruq', 'Dhuhr', 'Asr', 'Maghrib', 'Isha', 'Qiyam'];
const hasDate = (n) => n.kind === 'date' || (n.children || []).some(hasDate);
const nextAt = (c) => upcomingEvents(loc, cfg.calc, c.now, 2).find((e) => e.at > c.now).at;

const cases = [
  { label: 'Freitag 19:10 (nach Isha → morgen)', now: berlin(2026, 11, 27, 19, 10), D: { y: 2026, m: 11, d: 28 }, next: 'Fajr', qiyamFrom: { y: 2026, m: 11, d: 27 } },
  { label: 'Freitag 12:00 (vor Dhuhr)', now: berlin(2026, 11, 27, 12, 0), D: { y: 2026, m: 11, d: 27 }, next: 'Dhuhr', qiyamFrom: { y: 2026, m: 11, d: 27 } },
  { label: 'Samstag 03:00 (vor Fajr)', now: berlin(2026, 11, 28, 3, 0), D: { y: 2026, m: 11, d: 28 }, next: 'Fajr', qiyamFrom: { y: 2026, m: 11, d: 27 } },
  { label: 'Ramadan 17:00 (Iftar)', now: berlin(2027, 2, 20, 17, 0), D: { y: 2027, m: 2, d: 20 }, next: 'Maghrib', qiyamFrom: { y: 2027, m: 2, d: 20 } },
  { label: 'Sommer 23:30 (Isha erst 23:53)', now: berlin(2027, 6, 21, 23, 30), D: { y: 2027, m: 6, d: 21 }, next: 'Isha', qiyamFrom: { y: 2027, m: 6, d: 21 } },
];

for (const c of cases) {
  const t = computeDay(c.D, loc, cfg.calc);
  const qiyam = computeDay(c.qiyamFrom, loc, cfg.calc).lastThird;
  const expected = [t.fajr, t.sunrise, t.dhuhr, t.asr, t.maghrib, t.isha, qiyam].map(fmt);
  for (const family of ['small', 'medium', 'large']) {
    const st = await run(code, { family, now: c.now, cfg });
    const tx = texts(st.widget, c.now);
    ok(`${c.label} · ${family}: alle Gebete`, NAMES.every((n) => tx.includes(n)), tx.filter((x) => NAMES.includes(x)).join(' '));
    ok(`${c.label} · ${family}: richtige Zeiten`, expected.every((e) => tx.includes(e)), expected.filter((e) => !tx.includes(e)).join(' ') || expected.join(' '));
    ok(`${c.label} · ${family}: kein „Jumu’a“`, !tx.some((x) => /jum/i.test(x)));
    const hl = highlighted(st.widget).flat();
    ok(`${c.label} · ${family}: ${c.next} hervorgehoben`, hl.includes(c.next), hl.join(' '));
    ok(`${c.label} · ${family}: Himmel ohne Fehler`, !!st.widget.backgroundImage && st.logs.length === 0, st.logs.join(' '));
    ok(`${c.label} · ${family}: Aktualisierung spätestens beim nächsten Gebet`, st.widget.refreshAfterDate > c.now && st.widget.refreshAfterDate.getTime() <= Math.min(c.now + 61 * 60000, nextAt(c) + 1500));
    ok(`${c.label} · ${family}: ohne Countdown`, !hasDate(st.widget));
  }
  for (const family of ['accessoryRectangular', 'accessoryCircular', 'accessoryInline']) {
    const st = await run(code, { family, now: c.now, cfg });
    const tx = texts(st.widget, c.now).join(' ');
    const label = c.label.startsWith('Ramadan') ? 'Iftar' : c.next;
    ok(`${c.label} · ${family}`, tx.includes(label) && !st.widget.backgroundImage, tx);
    ok(`${c.label} · ${family}: ohne Countdown`, !hasDate(st.widget));
  }
}

// Ramadan: Hinweis mit Imsak/Iftar im großen Widget
{
  const now = berlin(2027, 2, 20, 17, 0);
  const tx = texts((await run(code, { family: 'large', now, cfg })).widget, now);
  ok('Ramadan: Tag und Iftar-Zeit', tx.some((x) => /^Ramadan · Tag \d+$/.test(x)) && tx.some((x) => x.startsWith('Imsak ') && x.includes('Iftar')), tx.slice(0, 8).join(' | '));
  ok('Ramadan: „Iftar“ groß, „Fastenbrechen“ als Hinweis', tx.includes('Iftar') && tx.includes('Fastenbrechen'));
  const tm = texts((await run(code, { family: 'medium', now, cfg })).widget, now);
  ok('Ramadan mittel: „Iftar“ nur einmal', tm.filter((x) => x === 'Iftar').length === 1, tm.slice(0, 6).join(' '));
}
// Nacht: Sterne und Mond im Bild; Tag: keine Sterne
{
  const night = await run(code, { family: 'medium', now: berlin(2026, 11, 27, 22, 0), cfg });
  const day = await run(code, { family: 'medium', now: berlin(2026, 11, 27, 12, 0), cfg });
  const stars = (w) => (w.backgroundImage.svg.match(/<ellipse/g) || []).length;
  ok('Nachts Sterne am Himmel', stars(night.widget) > 40, String(stars(night.widget)));
  ok('Mittags keine Sterne', stars(day.widget) < 25, String(stars(day.widget)));
  ok('Mond gezeichnet (Phase als Pfad)', /<path d="M/.test(night.widget.backgroundImage.svg));
}
// 12-Stunden-Uhr
{
  const now = berlin(2026, 11, 27, 12, 0);
  const tx = texts((await run(code, { family: 'small', now, cfg: { ...cfg, clock: '12' } })).widget, now);
  ok('12-Stunden-Uhr', tx.some((x) => /AM|PM/.test(x)), tx.join(' '));
}
// Ort mit Sonderzeichen (wie beim Kopieren in der App eingesetzt)
{
  const now = berlin(2026, 11, 27, 12, 0);
  const odd = { ...cfg, name: 'Köln "Süd" */ </script> ✓' };
  const tx = texts((await run(code, { family: 'medium', now, cfg: odd })).widget, now);
  ok('Ortsname mit Sonderzeichen', tx.includes(odd.name));
}
// Sperrbildschirm: lädt genau zum nächsten Gebet neu (kein Zwischendurch-Neuladen, spart iOS-Budget)
{
  const now = berlin(2026, 11, 27, 12, 0);
  const st = await run(code, { family: 'accessoryRectangular', now, cfg });
  const t = computeDay({ y: 2026, m: 11, d: 27 }, loc, cfg.calc);
  ok('Sperrbildschirm: Neuladen zur Dhuhr-Minute', st.widget.refreshAfterDate.getTime() === t.dhuhr + 1500);
  const tx = texts(st.widget);
  ok('Sperrbildschirm: groß Dhuhr, klein Asr', tx[0] === 'Dhuhr' && tx[1] === fmt(t.dhuhr) && tx[2] === 'Asr' && tx[3] === fmt(t.asr), tx.join(' '));
  const at = await run(code, { family: 'accessoryRectangular', now: t.dhuhr + 1500, cfg });
  const tx2 = texts(at.widget);
  ok('Zur Gebetszeit: „Dhuhr jetzt“ mit Kaaba', tx2[0] === 'Dhuhr' && tx2[1] === 'jetzt' && tx2[2] === 'Asr', tx2.join(' '));
  ok('„jetzt“ endet nach 20 Minuten', at.widget.refreshAfterDate.getTime() === t.dhuhr + 20 * 60000 + 1500);
  const after = await run(code, { family: 'accessoryRectangular', now: t.dhuhr + 20 * 60000 + 1500, cfg });
  ok('Danach Asr groß', texts(after.widget)[0] === 'Asr', texts(after.widget).join(' '));
  const md = await run(code, { family: 'medium', now: t.dhuhr + 5 * 60000, cfg });
  ok('Mittel zur Gebetszeit: jetzt + Dhuhr hervorgehoben', texts(md.widget).includes('jetzt') && highlighted(md.widget).flat().includes('Dhuhr'));
}
// In der App (Tippen aufs Widget): große Ansicht, kein Hinweisfenster
{
  const st = await run(code, { inApp: true, now: berlin(2026, 11, 27, 12, 0), cfg });
  ok('In der App: große Ansicht ohne Hinweis', st.presented === 'large' && !st.alert);
}
// Ohne eingesetzte Einstellungen: kein Fehler, kein Hinweistext
{
  const st = await run(code, { family: 'small', now: Date.now() });
  ok('Ohne Ort: nur „Athan“', texts(st.widget).join('') === 'Athan');
}
// Einstellungen aus der App übernehmen (Server), danach offline aus dem Zwischenspeicher
{
  const now = berlin(2026, 11, 27, 12, 0);
  const files = new Map();
  const id = 'ab'.repeat(16);
  const linked = { ...cfg, id, server: 'https://athan.test' };
  const berlinCfg = { name: 'Berlin', lat: 52.52, lon: 13.405, tz: 'Europe/Berlin', calc: { method: 'MWL', asr: 'standard', highLat: 'angle', adjust: {} }, clock: '24', hijriAdj: 0 };
  const net = (u) => { if (u === `https://athan.test/api/widget?id=${id}`) return JSON.stringify(berlinCfg); throw new Error('404'); };
  let st = await run(code, { family: 'medium', now, cfg: linked, files, net });
  const tb = computeDay({ y: 2026, m: 11, d: 27 }, berlinCfg, berlinCfg.calc);
  ok('Ort aus der App übernommen', texts(st.widget).includes('Berlin') && texts(st.widget).includes(fmt(tb.asr)), texts(st.widget).slice(0, 3).join(' '));
  st = await run(code, { family: 'medium', now: now + 10 * 60000, cfg: linked, files, net: () => { throw new Error('offline'); } });
  ok('Offline: zuletzt geladener Ort bleibt', texts(st.widget).includes('Berlin') && st.requests.length === 0);
  st = await run(code, { family: 'medium', now: now + 2 * 3600000, cfg: linked, files, net: () => { throw new Error('offline'); } });
  ok('Nach einer Stunde neu gefragt, offline trotzdem Berlin', st.requests.some((u) => u.includes('/api/widget')) && texts(st.widget).includes('Berlin'));
  const plain = await run(code, { family: 'medium', now, cfg });
  ok('Ohne Verknüpfung: keine Internet-Anfrage', plain.requests.length === 0);
}
// Selbst-Update: neuere Version ersetzt das Skript, die eigenen Einstellungen bleiben drin
{
  const now = berlin(2026, 11, 27, 12, 0);
  const linked = { ...cfg, id: 'cd'.repeat(16), server: 'https://athan.test' };
  const newer = code.replace(/WIDGET_VERSION = '[\d.]+'/, "WIDGET_VERSION = '9.9.9'");
  for (const iCloud of [false, true]) {
    const files = new Map();
    const st = await run(code, { family: 'small', now, cfg: linked, files, iCloud, net: (u) => (u.endsWith('/widget/athan-widget.js') ? newer : '{}') });
    const path = iCloud ? '/icloud/Documents/Athan.js' : '/local/Documents/Athan.js';
    const written = files.get(path) || '';
    ok(`Selbst-Update (${iCloud ? 'iCloud' : 'lokal'})`, written.includes("WIDGET_VERSION = '9.9.9'") && written.includes('"name":"Saarbrücken"') && written.includes(`"id":"${linked.id}"`));
    const again = await run(code, { family: 'small', now: now + 3600000, cfg: linked, files, iCloud, net: () => newer });
    ok(`Update höchstens zweimal am Tag (${iCloud ? 'iCloud' : 'lokal'})`, !again.requests.some((u) => u.endsWith('.js')));
  }
  const files = new Map();
  await run(code, { family: 'small', now, cfg: linked, files, net: (u) => (u.endsWith('.js') ? code : '{}') });
  ok('Gleiche Version: kein Überschreiben', !files.has('/local/Documents/Athan.js'));
  await run(code, { family: 'small', now, cfg: linked, files: new Map(), net: (u) => (u.endsWith('.js') ? '<html>Fehler</html>' : '{}') });
  const broken = new Map();
  await run(code, { family: 'small', now, cfg: linked, files: broken, net: (u) => (u.endsWith('.js') ? "WIDGET_VERSION = '9.9.9' kaputt" : '{}') });
  ok('Kaputte Antwort: kein Überschreiben', !broken.has('/local/Documents/Athan.js'));
}
ok('Größen definiert', Object.keys(SIZES).length === 6);

console.log(failed ? `\n${failed} Widget-Test(s) fehlgeschlagen` : '\nAlle Widget-Tests bestanden');
process.exit(failed ? 1 : 0);
