// Screenshots der echten Windows-App (Oberfläche im Edge-Fenster) für die Sichtprüfung.
// Die Bilder werden als Base64 ins Log geschrieben (Blöcke SHOT-BEGIN/SHOT-END).
import { chromium } from 'playwright-core';

const base = process.argv[2];
const shots = [
  ['heute-nacht', 1180, 820, 'heute', '2026-11-27T22:30:00Z'],
  ['heute-ramadan', 1180, 820, 'heute', '2027-02-20T15:10:00Z'],
  ['qibla', 1180, 820, 'qibla', '2026-11-27T12:00:00Z'],
  ['einstellungen', 1180, 820, 'einstellungen', '2026-11-27T12:00:00Z'],
  ['heute-gross', 1920, 1040, 'heute', '2026-11-27T14:20:00Z'],
];
const browser = await chromium.launch({ channel: 'msedge' });
for (const [name, w, h, hash, time] of shots) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, timezoneId: 'Europe/Berlin' });
  const pg = await ctx.newPage();
  await pg.clock.setFixedTime(new Date(time));
  await pg.goto(`${base}/#${hash}`);
  await pg.waitForTimeout(2000);
  const fonts = await pg.evaluate(() => [...document.fonts].length + ' Webfonts; Arabisch: ' + getComputedStyle(document.querySelector('.t-ar') || document.body).fontFamily);
  const buf = await pg.screenshot({ type: 'jpeg', quality: 72 });
  const b64 = buf.toString('base64');
  console.log(`SHOT-BEGIN ${name} ${fonts}`);
  for (let i = 0; i < b64.length; i += 4000) console.log('SHOT ' + b64.slice(i, i + 4000));
  console.log(`SHOT-END ${name}`);
  await ctx.close();
}
await browser.close();
