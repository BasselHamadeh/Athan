// Prüft alle Athan-Quellen aus web/muezzins.json (läuft in GitHub Actions mit Internet).
import { readFileSync } from 'node:fs';

const { voices } = JSON.parse(readFileSync(new URL('../web/muezzins.json', import.meta.url)));
const text = (b, a, z) => String.fromCharCode(...b.subarray(a, z));
const sniff = (b) => {
  if (b.length < 12) return '?';
  if (text(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  if (text(b, 4, 8) === 'ftyp') return 'm4a';
  if (text(b, 0, 4) === 'OggS') return 'ogg';
  return 'KEIN AUDIO: ' + JSON.stringify(Buffer.from(b.subarray(0, 60)).toString('latin1'));
};

let bad = 0;
for (const v of voices) {
  for (const url of v.src) {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 AthanApp/1.0' }, signal: AbortSignal.timeout(60000) });
      const b = new Uint8Array(await r.arrayBuffer());
      const kind = sniff(b);
      const ok = r.ok && !kind.startsWith('KEIN');
      if (!ok) bad++;
      console.log(`${ok ? 'OK ' : 'ERR'} ${v.id.padEnd(14)} ${r.status} ${(r.headers.get('content-type') || '-').padEnd(26)} ${String(Math.round(b.length / 1024)).padStart(6)} KB ${kind}  final=${r.url}`);
    } catch (e) {
      bad++;
      console.log(`ERR ${v.id.padEnd(14)} ${e.message}  ${url}`);
    }
  }
}
console.log(`Fertig, ${bad} Probleme`);
