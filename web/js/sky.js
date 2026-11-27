// Sternenhimmel: feste Sterne (Canvas), einzelne funkelnde Sterne, selten eine Sternschnuppe.
// Sichtbarkeit steuert app.js über die CSS-Variable --stars (0 = Tag, 1 = tiefe Nacht).

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function rng(seed) {
  let s = seed % 2147483647;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function drawStars(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const rnd = rng(1447);
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;

  // Milchstraße: zarter, diagonaler Schleier aus feinem Staub
  const dust = Math.min(1400, Math.round((w * h) / 900));
  for (let i = 0; i < dust; i++) {
    const t = rnd();
    const x = t * w;
    const y = h * (0.05 + 0.42 * t) + gauss() * h * 0.07;
    ctx.fillStyle = `rgba(220,228,255,${(0.05 + rnd() * 0.12).toFixed(3)})`;
    ctx.fillRect(x, y, 0.8, 0.8);
  }

  // Sterne: oben dichter, zum Horizont hin schwächer
  const n = Math.min(520, Math.round((w * h) / 2000));
  for (let i = 0; i < n; i++) {
    const x = rnd() * w;
    const y = Math.pow(rnd(), 1.4) * h * 0.95;
    const m = rnd();
    const r = m > 0.985 ? 1.6 : m > 0.94 ? 1.1 : 0.45 + rnd() * 0.45;
    const a = (0.35 + rnd() * 0.65) * (1 - (y / h) * 0.6);
    const tint = rnd();
    const col = tint > 0.92 ? '255,226,190' : tint > 0.82 ? '200,218,255' : '255,255,255';
    if (r > 1) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
      g.addColorStop(0, `rgba(${col},${(a * 0.35).toFixed(3)})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r * 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = `rgba(${col},${a.toFixed(3)})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
}

// Stile per CSSOM setzen (die Content-Security-Policy verbietet Inline-Styles)
function placeTwinkles(box) {
  const rnd = rng(786);
  box.replaceChildren();
  for (let i = 0; i < 18; i++) {
    const el = document.createElement('i');
    el.style.setProperty('--x', `${(rnd() * 96 + 2).toFixed(2)}%`);
    el.style.setProperty('--y', `${(Math.pow(rnd(), 1.3) * 62 + 2).toFixed(2)}%`);
    el.style.setProperty('--d', `${(2.8 + rnd() * 4.5).toFixed(2)}s`);
    el.style.setProperty('--delay', `${(-rnd() * 7).toFixed(2)}s`);
    el.style.setProperty('--s', `${(1.6 + rnd() * 1.6).toFixed(2)}px`);
    box.appendChild(el);
  }
}

let meteorTimer = 0;
function scheduleMeteor(box) {
  clearTimeout(meteorTimer);
  meteorTimer = setTimeout(() => {
    const stars = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--stars')) || 0;
    if (stars > 0.85 && !document.hidden && !reduceMotion()) {
      const m = document.createElement('b');
      m.className = 'meteor';
      m.style.setProperty('--x', `${(20 + Math.random() * 65).toFixed(1)}%`);
      m.style.setProperty('--y', `${(4 + Math.random() * 26).toFixed(1)}%`);
      box.appendChild(m);
      setTimeout(() => m.remove(), 1600);
    }
    scheduleMeteor(box);
  }, 35000 + Math.random() * 50000);
}

export function initSky() {
  const canvas = document.getElementById('starfield');
  const twinkles = document.getElementById('twinkles');
  if (!canvas || !twinkles) return;
  drawStars(canvas);
  placeTwinkles(twinkles);
  scheduleMeteor(twinkles);
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => drawStars(canvas), 200); });
}
