// Plattform-Schicht: Windows-App (lokale API) oder Web/PWA (optional mit eigenem Push-Server)

const meta = document.querySelector('meta[name="athan-desktop"]');
export const isDesktop = !!meta;
const token = meta?.content || '';

export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = { 'X-Athan-Token': token };
  let payload = body;
  if (body !== undefined && !raw) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(path, { method, headers, body: payload, cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`.trim());
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

export function desktopAudioUrl(id) { return `/api/audio/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`; }

// ---------- Web: Service Worker & Push-Server ----------
let swReg = null;
export async function registerSW() {
  if (isDesktop || !('serviceWorker' in navigator)) return null;
  try { swReg = await navigator.serviceWorker.register('sw.js', { scope: './' }); } catch { swReg = null; }
  return swReg;
}

let serverInfo; // { push: boolean, vapidPublicKey }
export async function detectServer() {
  if (isDesktop) return null;
  if (serverInfo !== undefined) return serverInfo;
  try {
    const r = await fetch('api/config', { cache: 'no-store' });
    serverInfo = r.ok && (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  } catch { serverInfo = null; }
  return serverInfo;
}

export const notifSupported = () => 'Notification' in window;
export const notifPermission = () => (notifSupported() ? Notification.permission : 'unsupported');

export async function requestNotifications() {
  if (!notifSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

export async function showNotification(title, opts = {}) {
  if (isDesktop) return api('/api/notify', { method: 'POST', body: { title, body: opts.body || '' } }).catch(() => {});
  if (notifPermission() !== 'granted') return;
  const o = { icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', renotify: !!opts.tag, ...opts };
  try {
    const reg = swReg || (await navigator.serviceWorker?.getRegistration());
    if (reg) return await reg.showNotification(title, o);
  } catch { /* weiter mit Fallback */ }
  try { new Notification(title, o); } catch {}
}

function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export const pushSupported = () => !isDesktop && 'PushManager' in window && 'serviceWorker' in navigator;

export async function currentPushSubscription() {
  if (!pushSupported()) return null;
  const reg = swReg || (await navigator.serviceWorker.getRegistration());
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Abo anlegen oder aktualisieren und dem eigenen Server die Einstellungen schicken. */
export async function syncPush(settings) {
  const info = await detectServer();
  if (!info?.push || !pushSupported() || notifPermission() !== 'granted' || !settings.location) return { ok: false, reason: !info?.push ? 'no-server' : 'no-permission' };
  const reg = swReg || (await navigator.serviceWorker.ready);
  let sub = await reg.pushManager.getSubscription();
  const key = b64uToBytes(info.vapidPublicKey);
  if (sub) {
    const cur = sub.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (cur && (cur.length !== key.length || cur.some((v, i) => v !== key[i]))) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const { location, calc, modes, pre, clock } = settings;
  const r = await fetch('api/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON(), settings: { location, calc, modes, pre, clock } }),
  });
  if (!r.ok) throw new Error('Server lehnte das Abo ab (' + r.status + ')');
  return { ok: true };
}

export async function testPush(delay = 0) {
  const sub = await currentPushSubscription();
  if (!sub) return false;
  const r = await fetch('api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint, delay }) });
  return r.ok;
}
