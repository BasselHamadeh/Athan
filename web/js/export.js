// Monatskalender als Bild (PNG) oder PDF – A4 hochkant, druckfreundlich, ohne fremde Bibliotheken.

const W = 1240, H = 1754; // A4 bei 150 dpi
const NAVY = '#10244C', INK = '#1B2A44', MUTED = '#6B7486', GOLD = '#B8914A', GOLD_SOFT = 'rgba(216,178,110,.16)', LINE = '#E6DFD0';

function loadImage(src) {
  return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
}

/**
 * data: { title: 'November 2026', place: 'Saarbrücken', method: 'Muslim World League', hijri: '…',
 *         cols: ['Fajr', …], rows: [{ day: 'Fr 27.', hijri: '17. Dsch. II', times: ['06:06', …], fri, today, ramadan }],
 *         ramadan: bool, url }
 */
export async function monthCanvas(data) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const serif = css.getPropertyValue('--serif').trim() || 'Georgia, serif';
  const sans = css.getPropertyValue('--sans').trim() || 'Arial, sans-serif';
  g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, W, H);

  // Kopf: Logo, Monat, Ort
  const M = 80;
  const logo = await loadImage(data.ramadan ? 'icons/icon-ramadan.svg' : 'icons/icon.svg');
  if (logo) g.drawImage(logo, M, 70, 110, 110);
  g.fillStyle = NAVY; g.textBaseline = 'alphabetic';
  g.font = `600 64px ${serif}`;
  g.fillText(data.title, M + 140, 128);
  g.fillStyle = MUTED; g.font = `400 26px ${sans}`;
  g.fillText(`Gebetszeiten · ${data.place}`, M + 142, 170);
  g.textAlign = 'right'; g.fillStyle = GOLD; g.font = `500 26px ${sans}`;
  g.fillText(data.hijri, W - M, 128);
  g.fillStyle = MUTED; g.font = `400 22px ${sans}`;
  g.fillText(data.method, W - M, 170);
  g.textAlign = 'left';
  g.strokeStyle = GOLD; g.lineWidth = 2;
  g.beginPath(); g.moveTo(M, 215); g.lineTo(W - M, 215); g.stroke();

  // Tabelle
  const top = 250, foot = 90, n = data.rows.length;
  const headH = 54, rowH = Math.min(46, (H - top - foot - headH) / n);
  const dayW = 150, hijW = 170, colW = (W - 2 * M - dayW - hijW) / data.cols.length;
  const colX = (i) => M + dayW + hijW + colW * i + colW / 2;
  g.font = `600 22px ${sans}`; g.fillStyle = NAVY;
  g.fillText('Tag', M + 14, top + 34);
  g.fillStyle = MUTED; g.fillText('Hidschri', M + dayW, top + 34);
  g.textAlign = 'center'; g.fillStyle = NAVY;
  data.cols.forEach((name, i) => g.fillText(name, colX(i), top + 34));
  g.textAlign = 'left';
  data.rows.forEach((r, i) => {
    const y = top + headH + i * rowH;
    if (r.today) { g.fillStyle = GOLD_SOFT; g.fillRect(M, y, W - 2 * M, rowH); g.strokeStyle = GOLD; g.lineWidth = 2; g.strokeRect(M + 1, y + 1, W - 2 * M - 2, rowH - 2); }
    else if (r.fri) { g.fillStyle = 'rgba(16,36,76,.05)'; g.fillRect(M, y, W - 2 * M, rowH); }
    g.strokeStyle = LINE; g.lineWidth = 1;
    g.beginPath(); g.moveTo(M, y + rowH); g.lineTo(W - M, y + rowH); g.stroke();
    const base = y + rowH / 2 + 8;
    g.fillStyle = r.fri ? NAVY : INK; g.font = `${r.fri || r.today ? 700 : 500} 23px ${sans}`;
    g.fillText(r.day, M + 14, base);
    g.fillStyle = r.ramadan ? GOLD : MUTED; g.font = `400 20px ${sans}`;
    g.fillText(r.hijri, M + dayW, base);
    g.textAlign = 'center'; g.fillStyle = INK; g.font = `${r.today ? 700 : 500} 23px ${sans}`;
    r.times.forEach((t, k) => g.fillText(t, colX(k), base));
    g.textAlign = 'left';
  });
  g.fillStyle = MUTED; g.font = `400 18px ${sans}`;
  g.fillText(`Freitage hinterlegt${data.ramadan ? ' · Ramadan-Tage in Gold' : ''}`, M, H - 46);
  g.textAlign = 'right'; g.fillText(data.url, W - M, H - 46); g.textAlign = 'left';
  return c;
}

const toBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));

/** PNG-Datei */
export const pngBlob = (canvas) => toBlob(canvas, 'image/png');

/** PDF (eine A4-Seite) mit dem Kalender als JPEG-Bild – kleine, überall lesbare Datei. */
export async function pdfBlob(canvas) {
  const jpg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
  const enc = new TextEncoder();
  const parts = [], offsets = [];
  let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
  const pw = 595.28, ph = 841.89;
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  obj(4, () => { push(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`); push(jpg); push('\nendstream'); });
  obj(5, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  const xref = len;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => String(offsets[n]).padStart(10, '0') + ' 00000 n \n').join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

/** Speichern: iPhone/iPad über „Teilen“ (Dateien/Fotos), sonst als Download. */
export async function saveFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return 'shared'; } catch (e) { if (e?.name === 'AbortError') return 'cancel'; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'download';
}
