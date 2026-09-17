import { api } from "./api";

const SERVICE_WORKER_URL = "/sw.js";

export function pushSupported(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof window.Notification !== "undefined"
  );
}

function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const normalized = publicKey.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return Promise.resolve(null);
  return navigator.serviceWorker.register(SERVICE_WORKER_URL).catch(() => null);
}

async function existingSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return null;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

// The server maps subscriptions to the signed-in user, so re-register after
// login or a server restart to re-establish the association.
export async function resyncPushSubscription(): Promise<boolean> {
  const subscription = await existingSubscription();
  if (!subscription) return false;
  try {
    await api.registerPushSubscription(subscription.toJSON());
    return true;
  } catch {
    return false;
  }
}

export async function enablePush(): Promise<boolean> {
  if (!pushSupported() || Notification.permission === "denied") return false;
  if (Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return false;
  }
  try {
    let subscription = await existingSubscription();
    if (!subscription) {
      if (!(await registerServiceWorker())) return false;
      const { key } = await api.pushPublicKey();
      if (!key) return false;
      const registration = await navigator.serviceWorker.ready;
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(key),
      });
    }
    await api.registerPushSubscription(subscription.toJSON());
    return true;
  } catch {
    return false;
  }
}

export async function disablePush(): Promise<boolean> {
  const subscription = await existingSubscription();
  if (!subscription) return true;
  try {
    await api.unregisterPushSubscription(subscription.endpoint);
    await subscription.unsubscribe();
    return true;
  } catch {
    return false;
  }
}
