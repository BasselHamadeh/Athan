// Kurzer Athan: findet in jeder Aufnahme die letzte Atempause vor 29 s („die ersten Verse“) und
// schreibt daraus .caf-Töne fürs iPhone (iOS spielt Mitteilungstöne nur bis 30 s, Format IMA4).
//
//   node scripts/athan-sounds.mjs --analyze              Schnittpunkte ermitteln → JSON (für web/muezzins.json)
//   node scripts/athan-sounds.mjs --out web/sounds       .caf-Dateien mit den Schnittpunkten aus muezzins.json
//   node scripts/athan-sounds.mjs --analyze --out DIR    beides (Kontrolle)
//   node scripts/athan-sounds.mjs --file x.mp3           nur eine lokale Datei analysieren (Test)
//
// Braucht ffmpeg; Aufnahmen werden aus dem Internet geladen (läuft in GitHub Actions).
import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const MAX_CLIP = 29.2;   // Sekunden – sicher unter der 30-s-Grenze von iOS
const RATE = 8000, HOP = 160;    // Analyse: 8 kHz, 20-ms-Fenster
const FRAME = HOP / RATE;

function ffmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-v', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => err.push(c));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}: ${Buffer.concat(err).toString().slice(-400)}`))));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

export async function decode(buf, seconds = 50) {
  const pcm = await ffmpeg(['-i', 'pipe:0', '-t', String(seconds), '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], buf);
  return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/** Lautstärkeverlauf in dB (20-ms-Fenster). */
export function envelope(pcm) {
  const n = Math.floor(pcm.length / HOP), db = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = i * HOP; k < (i + 1) * HOP; k++) sum += pcm[k] * pcm[k];
    db[i] = 20 * Math.log10(Math.sqrt(sum / HOP) / 32768 + 1e-9);
  }
  // leicht glätten (Mittel über 3 Fenster), damit einzelne Knackser keine Pause vortäuschen
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) sm[i] = (db[Math.max(0, i - 1)] + db[i] + db[Math.min(n - 1, i + 1)]) / 3;
  return sm;
}

/**
 * Beginn der Stimme und Ende der ersten Verse.
 * Pause = mind. 0,3 s deutlich leiser als die Stimme (relativ zum 90-%-Pegel – Hall in Moscheen
 * lässt die Pausen nie ganz still werden). Gewählt wird die späteste Pause, die noch ≤ 29,2 s
 * nach Stimmbeginn liegt; mindestens 14 s, damit wirklich mehrere Verse erklingen.
 */
export function findClip(db) {
  const loud = pct(db, 0.9);
  let first = db.findIndex((v) => v > loud - 24);
  if (first < 0) first = 0;
  const start = Math.max(0, first * FRAME - 0.08);
  for (const drop of [20, 16, 12, 9, 7]) {
    const thr = loud - drop, pauses = [];
    let i = first;
    while (i < db.length) {
      if (db[i] < thr) {
        let j = i; while (j < db.length && db[j] < thr) j++;
        const dur = (j - i) * FRAME;
        if (dur >= 0.3) pauses.push({ at: i * FRAME, dur });
        i = j;
      } else i++;
    }
    const fits = pauses.filter((p) => p.at - start >= 14 && p.at + Math.min(0.25, p.dur / 2) - start <= MAX_CLIP);
    if (fits.length) {
      const p = fits[fits.length - 1];
      const end = p.at + Math.min(0.25, p.dur / 2);
      return { start: +start.toFixed(2), end: +end.toFixed(2), drop, pauses: pauses.map((q) => +(q.at - start).toFixed(1)).filter((x) => x < 45) };
    }
  }
  return { start: +start.toFixed(2), end: +(start + 28.5).toFixed(2), drop: null, pauses: [] };
}

/** .caf (IMA4, mono, 32 kHz) mit sanftem Ein-/Ausblenden und gleicher Lautheit für alle Stimmen. */
export async function makeCaf(buf, clip, outFile, raw = false) {
  const dur = Math.min(MAX_CLIP, clip.end - clip.start);
  const fade = Math.min(0.7, dur / 4);
  const af = `loudnorm=I=-13:TP=-1.2:LRA=11,aresample=32000,afade=t=in:d=0.04,afade=t=out:st=${(dur - fade).toFixed(3)}:d=${fade.toFixed(3)}`;
  const input = raw ? ['-f', 's16le', '-ac', '1', '-ar', '22050', '-i', 'pipe:0'] : ['-i', 'pipe:0'];
  // in eine Datei (nicht in eine Pipe) schreiben, damit die Länge des data-Blocks eingetragen wird
  await ffmpeg([...input, '-ss', String(clip.start), '-t', dur.toFixed(3), '-af', af, '-ac', '1', '-c:a', 'adpcm_ima_qt',
    '-fflags', '+bitexact', '-f', 'caf', '-y', outFile], buf);
  return statSync(outFile).size;
}

// Sanfter Gong (gleich wie in der App) als Rohdaten – für die Stimme „Sanfter Gong“
export function chimePcm(rate = 22050) {
  const n = Math.floor(8 * rate), pcm = new Int16Array(n);
  const notes = [523.25, 659.25, 783.99];
  for (let r = 0; r < 3; r++) notes.forEach((f, i) => {
    const start = r * 2.4 + i * 0.42;
    for (const [mult, amp] of [[1, 1], [2.76, 0.28], [5.4, 0.1]]) {
      for (let k = Math.floor(start * rate); k < n && k < (start + 2.6) * rate; k++) {
        const t = k / rate - start;
        const env = Math.exp(-t * 2.2) * Math.min(1, t * 50);
        pcm[k] = Math.max(-32000, Math.min(32000, pcm[k] + 5200 * amp * env * Math.sin(2 * Math.PI * f * mult * t)));
      }
    }
  });
  return Buffer.from(pcm.buffer);
}

async function download(v) {
  for (const url of v.src) {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 AthanApp/1.3' }, signal: AbortSignal.timeout(90000) });
      if (!r.ok) continue;
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length > 1000 && (b.subarray(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))) return b;
    } catch (e) { console.error(`  ${v.id}: ${e.message}`); }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  if (opt('--file')) {
    const db = envelope(await decode(readFileSync(opt('--file'))));
    console.log(JSON.stringify(findClip(db)));
    return;
  }
  const analyze = args.includes('--analyze');
  const out = opt('--out');
  if (out) mkdirSync(out, { recursive: true });
  const catalog = JSON.parse(readFileSync(new URL('../web/muezzins.json', import.meta.url)));
  const result = {};
  let made = 0, failed = 0;
  for (const v of catalog.voices) {
    const buf = await download(v);
    if (!buf) { console.log(`ERR ${v.id}: nicht ladbar`); failed++; continue; }
    let clip = v.clip ? { start: v.clip[0], end: v.clip[1] } : null;
    if (analyze || !clip) {
      const found = findClip(envelope(await decode(buf)));
      result[v.id] = found;
      console.log(`${v.id.padEnd(14)} Stimme ab ${found.start.toFixed(2)} s, Ende ${found.end.toFixed(2)} s (${(found.end - found.start).toFixed(1)} s, Schwelle −${found.drop} dB), Pausen: ${found.pauses.join(', ')}`);
      if (!clip) clip = found;
    }
    if (out) {
      const size = await makeCaf(buf, clip, join(out, `${v.id}.caf`));
      console.log(`  → ${v.id}.caf ${(size / 1024).toFixed(0)} KB`);
      made++;
    }
  }
  if (out) {
    await makeCaf(chimePcm(), { start: 0, end: 8 }, join(out, 'chime.caf'), true);
    made++;
  }
  if (analyze) console.log('CLIPS ' + JSON.stringify(Object.fromEntries(Object.entries(result).map(([k, r]) => [k, [r.start, r.end]]))));
  console.log(`Fertig: ${made} Töne, ${failed} Fehler`);
  if (failed > 3) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
