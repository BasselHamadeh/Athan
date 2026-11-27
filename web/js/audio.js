// Audio: Athan-Wiedergabe, sanfter Gong (synthetisch), eigene Aufnahme (IndexedDB)

let ctx;
function audioCtx() {
  if (!ctx) { const C = window.AudioContext || window.webkitAudioContext; if (C) ctx = new C(); }
  return ctx;
}

// Glockenartiger Gong aus Teiltönen – braucht keinen Download
export function playChime(volume = 0.8, repeats = 3) {
  const c = audioCtx(); if (!c) return { stop() {}, done: Promise.resolve() };
  if (c.state === 'suspended') c.resume();
  const master = c.createGain(); master.gain.value = volume * 0.6; master.connect(c.destination);
  const notes = [523.25, 659.25, 783.99];
  const t0 = c.currentTime + 0.05;
  let end = t0;
  for (let r = 0; r < repeats; r++) {
    notes.forEach((f, i) => {
      const start = t0 + r * 2.4 + i * 0.42;
      for (const [mult, amp] of [[1, 1], [2.76, 0.28], [5.4, 0.1]]) {
        const o = c.createOscillator(); const g = c.createGain();
        o.type = 'sine'; o.frequency.value = f * mult;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(amp * 0.5, start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 2.6);
        o.connect(g); g.connect(master); o.start(start); o.stop(start + 2.7);
      }
      end = Math.max(end, start + 2.7);
    });
  }
  let timer;
  const done = new Promise((res) => { timer = setTimeout(res, (end - c.currentTime) * 1000); });
  return { stop() { clearTimeout(timer); try { master.disconnect(); } catch {} }, done };
}

// ---- eigene Aufnahme ----
const DB = 'athan-audio', STORE = 'files';
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
export async function saveCustom(file) {
  const d = await db();
  await new Promise((res, rej) => { const tx = d.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(file, 'custom'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
export async function loadCustom() {
  try {
    const d = await db();
    return await new Promise((res) => { const tx = d.transaction(STORE); const q = tx.objectStore(STORE).get('custom'); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
  } catch { return null; }
}

// Kurze Stille als WAV – zum Freischalten der Wiedergabe auf iOS
function silentWavUrl() {
  const n = 800, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

/** Ein Abspieler für Athan und Vorschau. sources(id) liefert eine Liste möglicher URLs. */
export class Player {
  constructor(sources) {
    this.sources = sources;
    this.el = new Audio();
    this.el.preload = 'none';
    this.current = null;      // { id, kind }
    this.chime = null;
    this.unlocked = false;
    this.listeners = new Set();
    this.limit = 0;            // Sekunden; 0 = ganz abspielen
    this.base = 0.9;
    this.el.addEventListener('ended', () => this._end());
    this.el.addEventListener('timeupdate', () => this._checkLimit());
  }

  // „Erste Verse“: an der Atempause sanft ausblenden und anhalten (iOS kennt keine Lautstärke – dort nur anhalten)
  _checkLimit() {
    if (!this.limit || !this.current || this.current.id === 'chime') return;
    const left = this.limit - this.el.currentTime;
    if (left <= 0) { this.limit = 0; try { this.el.pause(); } catch {} this.el.volume = this.base; this._end(); return; }
    if (left < 1.2 && !this._fade) {
      this._fade = setInterval(() => {
        const l = this.limit - this.el.currentTime;
        if (!this.limit || l <= 0) { clearInterval(this._fade); this._fade = null; this._checkLimit(); return; }
        try { this.el.volume = Math.max(0, this.base * (l / 1.2)); } catch {}
      }, 50);
    }
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) fn(this.current); }
  _end() {
    if (this._fade) { clearInterval(this._fade); this._fade = null; }
    this.current = null; this._emit();
  }

  async unlock() {
    if (this.unlocked) return true;
    try {
      this.el.src = silentWavUrl(); this.el.volume = 0.01;
      await this.el.play(); this.el.pause();
      const c = audioCtx(); if (c && c.state === 'suspended') await c.resume();
      this.unlocked = true;
    } catch { /* noch keine Nutzergeste */ }
    return this.unlocked;
  }

  async play(id, { volume = 0.9, kind = 'preview', limit = 0 } = {}) {
    this.stop();
    this.limit = limit > 0 ? limit : 0;
    this.base = volume;
    this.current = { id, kind, loading: true }; this._emit();
    if (id === 'chime') {
      this.chime = playChime(volume);
      this.current = { id, kind }; this._emit();
      this.chime.done.then(() => { if (this.current?.id === 'chime') this._end(); });
      return true;
    }
    const urls = await this.sources(id);
    for (const url of urls) {
      if (this.current?.id !== id) return false; // inzwischen gestoppt
      try {
        this.el.src = url; this.el.volume = volume;
        await this.el.play();
        this.current = { id, kind }; this._emit();
        return true;
      } catch (e) {
        if (e?.name === 'NotAllowedError') { this.current = null; throw e; } // Aufrufer zeigt „Athan abspielen“
      }
    }
    // Quelle nicht erreichbar → Gong als Ersatz, damit niemand den Athan verpasst
    if (kind === 'athan') { this.current = null; return this.play('chime', { volume, kind }); }
    this._end();
    return false;
  }

  stop() {
    if (this.chime) { this.chime.stop(); this.chime = null; }
    if (this._fade) { clearInterval(this._fade); this._fade = null; }
    try { this.el.pause(); this.el.volume = this.base; } catch {}
    if (this.current) { this.current = null; this._emit(); }
  }
  get playing() { return !!this.current; }
}
