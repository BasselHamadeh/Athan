// Nachbau der Scriptable-API (nur was das Athan-Widget nutzt) – zum Testen in Node und für Vorschaubilder.
// Führt den Widget-Code mit fester Uhrzeit aus und liefert den Widget-Baum; toHTML() zeichnet ihn grob nach.
import { readFileSync } from 'node:fs';

export const SIZES = {
  small: [158, 158], medium: [338, 158], large: [338, 354],
  accessoryRectangular: [172, 76], accessoryCircular: [76, 76], accessoryInline: [240, 22],
};

class Color {
  constructor(hex, alpha = 1) { this.hex = hex.replace('#', ''); this.alpha = alpha; }
  static white() { return new Color('#FFFFFF'); }
  static black() { return new Color('#000000'); }
  static clear() { return new Color('#000000', 0); }
  css() { const h = this.hex.length === 3 ? [...this.hex].map((c) => c + c).join('') : this.hex; const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); return `rgba(${r},${g},${b},${this.alpha})`; }
}
class Font {
  constructor(name, size) { this.name = name; this.size = size; }
}
for (const w of ['ultraLight', 'thin', 'light', 'regular', 'medium', 'semibold', 'bold', 'heavy', 'black']) {
  Font[`${w}SystemFont`] = (s) => new Font(`system-${w}`, s);
  Font[`${w}RoundedSystemFont`] = (s) => new Font(`rounded-${w}`, s);
  Font[`${w}MonospacedSystemFont`] = (s) => new Font(`mono-${w}`, s);
}
Font.systemFont = (s) => new Font('system-regular', s);
Font.italicSystemFont = (s) => new Font('system-italic', s);
class LinearGradient { colors = []; locations = []; }
class Size { constructor(w, h) { this.width = w; this.height = h; } }
class Point { constructor(x, y) { this.x = x; this.y = y; } }
class Rect { constructor(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h; } }
class Path {
  d = [];
  move(p) { this.d.push(`M${p.x.toFixed(2)} ${p.y.toFixed(2)}`); }
  addLine(p) { this.d.push(`L${p.x.toFixed(2)} ${p.y.toFixed(2)}`); }
  addCurve(p, c1, c2) { this.d.push(`C${c1.x.toFixed(2)} ${c1.y.toFixed(2)} ${c2.x.toFixed(2)} ${c2.y.toFixed(2)} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`); }
  closeSubpath() { this.d.push('Z'); }
}
class Image { constructor(svg, w, h) { this.svg = svg; this.size = new Size(w, h); } }
class DrawContext {
  size = new Size(100, 100); respectScreenScale = false; opaque = true;
  #ops = []; #fill = 'black'; #path = null;
  setFillColor(c) { this.#fill = c.css(); }
  #stroke = 'black'; #lw = 1;
  setStrokeColor(c) { this.#stroke = c.css(); } setLineWidth(w) { this.#lw = w; }
  strokePath() { if (this.#path) this.#ops.push(`<path d="${this.#path.d.join(' ')}" fill="none" stroke="${this.#stroke}" stroke-width="${this.#lw}" stroke-linejoin="miter"/>`); this.#path = null; }
  fillRect(r) { this.#ops.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="${this.#fill}"/>`); }
  fillEllipse(r) { this.#ops.push(`<ellipse cx="${r.x + r.width / 2}" cy="${r.y + r.height / 2}" rx="${r.width / 2}" ry="${r.height / 2}" fill="${this.#fill}"/>`); }
  addPath(p) { this.#path = p; }
  fillPath() { if (this.#path) this.#ops.push(`<path d="${this.#path.d.join(' ')}" fill="${this.#fill}"/>`); this.#path = null; }
  getImage() { const { width: w, height: h } = this.size; this.drawn = this.#ops.length; return new Image(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">${this.#ops.join('')}</svg>`, w, h); }
}
class SFSymbol { static named(n) { const s = new SFSymbol(); s.name = n; s.image = new Image(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="white"/></svg>`, 10, 10); return s; } applyFont() {} }

class Element { constructor(kind) { this.kind = kind; } }
class WidgetText extends Element {
  constructor(t) { super('text'); this.text = t; this.align = 'left'; }
  leftAlignText() { this.align = 'left'; } centerAlignText() { this.align = 'center'; } rightAlignText() { this.align = 'right'; }
}
class WidgetDate extends WidgetText {
  constructor(d) { super(''); this.kind = 'date'; this.date = d; this.style = 'date'; }
  applyTimerStyle() { this.style = 'timer'; } applyRelativeStyle() { this.style = 'relative'; } applyTimeStyle() { this.style = 'time'; }
  applyDateStyle() { this.style = 'date'; } applyOffsetStyle() { this.style = 'offset'; }
}
class WidgetImage extends Element { constructor(img) { super('image'); this.image = img; this.tintColor = null; } }
class WidgetSpacer extends Element { constructor(len) { super('spacer'); this.length = len; } }
class Container extends Element {
  children = []; spacing = 0; padding = null; backgroundColor = null; backgroundImage = null; backgroundGradient = null;
  addText(t) { const e = new WidgetText(t); this.children.push(e); return e; }
  addDate(d) { if (!(d instanceof globalThis.Date)) throw new Error('addDate braucht ein Date'); const e = new WidgetDate(d); this.children.push(e); return e; }
  addImage(i) { const e = new WidgetImage(i); this.children.push(e); return e; }
  addSpacer(len = null) { const e = new WidgetSpacer(len); this.children.push(e); return e; }
  addStack() { const e = new WidgetStack(); this.children.push(e); return e; }
  setPadding(t, l, b, r) { this.padding = [t, l, b, r]; }
  useDefaultPadding() { this.padding = null; }
}
class WidgetStack extends Container {
  constructor() { super('stack'); this.dir = 'h'; this.align = 'top'; this.size = new Size(0, 0); this.cornerRadius = 0; }
  layoutHorizontally() { this.dir = 'h'; } layoutVertically() { this.dir = 'v'; }
  topAlignContent() { this.align = 'top'; } centerAlignContent() { this.align = 'center'; } bottomAlignContent() { this.align = 'bottom'; }
}
class ListWidget extends Container {
  constructor() { super('widget'); this.refreshAfterDate = null; this.url = null; this.addAccessoryWidgetBackground = false; this.presented = null; }
  presentSmall() { this.presented = 'small'; return Promise.resolve(); }
  presentMedium() { this.presented = 'medium'; return Promise.resolve(); }
  presentLarge() { this.presented = 'large'; return Promise.resolve(); }
  presentAccessoryRectangular() { this.presented = 'accessoryRectangular'; return Promise.resolve(); }
  presentAccessoryCircular() { this.presented = 'accessoryCircular'; return Promise.resolve(); }
  presentAccessoryInline() { this.presented = 'accessoryInline'; return Promise.resolve(); }
}

/**
 * Widget-Code ausführen. code = Inhalt von web/widget/athan-widget.js (optional mit eingesetzter CONFIG).
 * Liefert { widget, presented, alert, logs }.
 */
export async function run(code, { family = 'small', now = Date.now(), cfg, inApp = false, choose = 1, screen = [390, 844], files = new Map(), net = null, iCloud = false } = {}) {
  if (cfg) code = code.replace(/\/\*CONFIG\*\/[\s\S]*?\/\*END\*\//, () => `/*CONFIG*/${JSON.stringify(cfg)}/*END*/`);
  const RealDate = globalThis.Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(now); }
    static now() { return now; }
  }
  const state = { widget: null, presented: null, alert: null, logs: [], completed: false };
  let lastWidget = null;
  class TrackedWidget extends ListWidget { constructor() { super(); lastWidget = this; } }
  const Alert = class { title = ''; message = ''; actions = []; addAction(a) { this.actions.push(a); } addCancelAction() {} presentSheet() { state.alert = this; return Promise.resolve(choose); } presentAlert() { return this.presentSheet(); } };
  // Dateien (gemeinsam über mehrere Läufe, wenn files übergeben wird) und Internet (net(url) → Text oder Fehler)
  const fmFor = (cloud) => ({
    documentsDirectory: () => (cloud ? '/icloud/Documents' : '/local/Documents'),
    joinPath: (a, b) => `${a}/${b}`,
    fileExists: (p) => files.has(p),
    readString: (p) => files.get(p),
    writeString: (p, v) => { files.set(p, v); state.writes.push(p); },
    isFileStoredIniCloud: (p) => p.startsWith('/icloud/'),
  });
  const FileManager = { local: () => fmFor(false), iCloud: () => fmFor(true) };
  class Request {
    constructor(url) { this.url = url; this.timeoutInterval = 60; state.requests.push(url); }
    async loadString() { if (!net) throw new Error('offline'); return net(this.url); }
    async loadJSON() { return JSON.parse(await this.loadString()); }
  }
  state.writes = []; state.requests = [];
  const env = {
    Color, Font, LinearGradient, Size, Point, Rect, Path, DrawContext, SFSymbol, ListWidget: TrackedWidget, Alert,
    FileManager, Request, module: { filename: iCloud ? '/icloud/Documents/Athan.js' : '/local/Documents/Athan.js' },
    Device: { screenSize: () => new Size(...screen), screenScale: () => 3 },
    Script: { setWidget: (w) => { state.widget = w; }, complete: () => { state.completed = true; }, name: () => 'Athan' },
    config: { runsInWidget: !inApp, runsInApp: inApp, runsInAccessoryWidget: family.startsWith('accessory'), widgetFamily: inApp ? null : family },
    args: { widgetParameter: null, queryParameters: {} },
    console: { log: (...a) => state.logs.push(a.join(' ')), error: (...a) => state.logs.push(a.join(' ')) },
    Date: FakeDate,
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction(...Object.keys(env), code)(...Object.values(env));
  if (inApp) { state.widget = lastWidget; state.presented = lastWidget?.presented; }
  state.files = files;
  return state;
}

export const loadCode = () => readFileSync(new URL('../web/widget/athan-widget.js', import.meta.url), 'utf8');

/** Alle Texte im Baum (für Prüfungen). */
export function texts(node, now) {
  const out = [];
  const walk = (n) => {
    if (n.kind === 'text') out.push(n.text);
    if (n.kind === 'date') out.push(dateText(n, now));
    for (const c of n.children || []) walk(c);
  };
  walk(node);
  return out;
}
/** Elemente mit Hervorhebung (Gold-Hintergrund). */
export function highlighted(node) {
  const out = [];
  const walk = (n) => { if (n.kind === 'stack' && n.backgroundColor && n.backgroundColor.alpha < 0.5) out.push(texts(n)); for (const c of n.children || []) walk(c); };
  walk(node);
  return out;
}

function dateText(n, now) {
  const ms = n.date.getTime() - (now ?? Date.now());
  const s = Math.abs(Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  if (n.style === 'timer') return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
  if (n.style === 'relative') return h ? `${h} Std., ${m} Min.` : `${m} Min.`;
  return n.date.toISOString();
}

const FONTS = {
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
  system: "-apple-system, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif",
  rounded: "'SF Pro Rounded', ui-rounded, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  arabic: "'Geeza Pro', 'Noto Naskh Arabic', 'Noto Sans Arabic', serif",
};
const WEIGHT = { ultraLight: 200, thin: 250, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, heavy: 800, black: 900 };
function fontCss(f) {
  if (!f) return '';
  let fam = FONTS.system, wt = 400;
  if (f.name.startsWith('IowanOldStyle')) { fam = FONTS.serif; wt = f.name.endsWith('Bold') ? 700 : 400; }
  else if (f.name.startsWith('GeezaPro')) { fam = FONTS.arabic; wt = f.name.endsWith('Bold') ? 700 : 400; }
  else { const [kind, w] = f.name.split('-'); fam = kind === 'rounded' ? FONTS.rounded : FONTS.system; wt = WEIGHT[w] || 400; }
  return `font-family:${fam};font-weight:${wt};font-size:${f.size}px;line-height:1.2;`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Wie in SwiftUI: ein Stapel mit flexiblem Abstand (auch tiefer verschachtelt) dehnt sich in dieser Richtung aus
function flex(n, axis) {
  if (n.kind !== 'stack') return false;
  return n.children.some((c) => (c.kind === 'spacer' && c.length == null && (n.dir === 'h') === (axis === 'h')) || flex(c, axis));
}

/** Grobe HTML-Nachbildung (Flexbox) – zum Ansehen, nicht pixelgenau. */
export function toHTML(widget, family, now) {
  const [W, H] = SIZES[family];
  const accessory = family.startsWith('accessory');
  const pad = widget.padding || (accessory ? [0, 0, 0, 0] : [16, 16, 16, 16]);
  const node = (n, parentDir) => {
    if (n.kind === 'spacer') return n.length == null ? '<div style="flex:1 1 0;min-width:0;min-height:0"></div>' : `<div style="flex:0 0 ${n.length}px"></div>`;
    if (n.kind === 'text' || n.kind === 'date') {
      const t = n.kind === 'date' ? dateText(n, now) : n.text;
      const color = n.textColor ? n.textColor.css() : '#fff';
      return `<span class="t" dir="auto" data-scale="${n.minimumScaleFactor ?? 1}" style="${fontCss(n.font)}color:${color};opacity:${n.textOpacity ?? 1};text-align:${n.align};">${esc(t)}</span>`;
    }
    if (n.kind === 'image') return `<span style="display:inline-block;flex:none;width:${n.imageSize?.width || 12}px;height:${n.imageSize?.height || 12}px">${n.image.svg.replace('<svg ', '<svg width="100%" height="100%" ')}</span>`;
    const st = n;
    const dir = st.dir === 'v' ? 'column' : 'row';
    const al = st.dir === 'v' ? 'flex-start' : { top: 'flex-start', center: 'center', bottom: 'flex-end' }[st.align];
    const p = st.padding || [0, 0, 0, 0];
    const main = parentDir === 'h' ? 'h' : 'v', cross = main === 'h' ? 'v' : 'h';
    const grow = flex(st, main) ? 'flex:1 1 0;' : 'flex:0 0 auto;';
    const stretch = flex(st, cross) ? 'align-self:stretch;' : '';
    const size = `${st.size?.width ? `width:${st.size.width}px;flex:0 0 ${st.size.width}px;` : ''}${st.size?.height ? `height:${st.size.height}px;` : ''}`;
    return `<div style="display:flex;flex-direction:${dir};align-items:${al};gap:${st.spacing}px;padding:${p.join('px ')}px;${st.backgroundColor ? `background:${st.backgroundColor.css()};` : ''}border-radius:${st.cornerRadius || 0}px;${grow}${stretch}${size}min-width:0;box-sizing:border-box">${st.children.map((c) => node(c, st.dir)).join('')}</div>`;
  };
  const bg = widget.backgroundImage ? `<div class="bg">${widget.backgroundImage.svg}</div>`
    : widget.backgroundGradient ? `<div class="bg" style="background:linear-gradient(${widget.backgroundGradient.colors.map((c) => c.css()).join(',')})"></div>`
    : accessory ? `<div class="bg" style="background:${widget.addAccessoryWidgetBackground ? 'rgba(255,255,255,.18)' : 'transparent'}"></div>` : '';
  return `<div class="widget ${family}" style="width:${W}px;height:${H}px;border-radius:${family === 'accessoryCircular' ? '50%' : accessory ? '10px' : '22px'}">
    ${bg}<div class="content" style="padding:${pad.join('px ')}px;gap:${widget.spacing}px">${widget.children.map((c) => node(c, 'v')).join('')}</div></div>`;
}
