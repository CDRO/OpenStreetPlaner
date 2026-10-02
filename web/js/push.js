// Web-Push im Browser: Service Worker registrieren, Abonnement anlegen/lösen.

export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
}

let watchingUpdates = false;

/**
 * Registriert den Service Worker. onUpdate wird gerufen, wenn nach einem Release ein neuer Worker die
 * Seite übernommen hat (die laufende Seite nutzt dann noch die alten Dateien und sollte neu laden).
 * Lange offene Tabs prüfen alle 30 Minuten und beim Zurückkehren, ob es eine neue Version gibt.
 */
export async function registerWorker({ onUpdate = null } = {}) {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    if (!watchingUpdates) {
      watchingUpdates = true;
      let hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController && onUpdate) onUpdate();
        hadController = true;
      });
      const check = () => reg.update().catch(() => {});
      globalThis.setInterval(check, 30 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    }
    return reg;
  } catch {
    return null;
  }
}

function keyToBytes(base64url) {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Aktuelles Abonnement dieses Browsers (oder null). */
export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

/** Legt ein Abonnement an (fragt bei Bedarf die Berechtigung ab). Liefert das PushSubscription-JSON. */
export async function subscribe(publicKey) {
  if (!pushSupported()) throw new Error('Push wird von diesem Browser nicht unterstützt (HTTPS nötig).');
  const reg = (await navigator.serviceWorker.getRegistration('/')) || (await registerWorker());
  if (!reg) throw new Error('Service Worker konnte nicht registriert werden.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt.');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });
  }
  return sub.toJSON();
}

export async function unsubscribe() {
  const sub = await currentSubscription();
  if (sub) await sub.unsubscribe();
}

export function permissionState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}
