import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

const currentDir = dirname(fileURLToPath(import.meta.url));
const DATA_FILE =
  process.env.PUSH_DATA_FILE ?? join(currentDir, "..", "data", "push.json");
const DEFAULT_VAPID_SUBJECT = "mailto:notes@localhost";

export interface PushSubscriptionRecord {
  endpoint: string;
  email: string;
  p256dh: string;
  auth: string;
}

export interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

// Notification-scheduler state that must survive a restart: whether changes
// are still waiting for their quiet period and when the last notification
// went out (the cooldown anchor).
export interface NoteNotifyState {
  lastChangedAt: number;
  lastNotifiedAt: number;
  pending: boolean;
  editors: string[];
  title: string;
}

interface PushData {
  vapid: VapidDetails | null;
  subscriptions: PushSubscriptionRecord[];
  notes: Record<string, NoteNotifyState>;
}

let data: PushData = { vapid: null, subscriptions: [], notes: {} };
let loaded = false;

let writeChain: Promise<void> = Promise.resolve();

function persist(): Promise<void> {
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(DATA_FILE), { recursive: true });
      await writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
    });
  return writeChain;
}

function normalizeVapid(raw: unknown): VapidDetails | null {
  const vapid = (raw ?? {}) as Partial<VapidDetails>;
  if (
    typeof vapid.publicKey !== "string" ||
    vapid.publicKey.length === 0 ||
    typeof vapid.privateKey !== "string" ||
    vapid.privateKey.length === 0
  ) {
    return null;
  }
  return {
    subject:
      typeof vapid.subject === "string" && vapid.subject.length > 0
        ? vapid.subject
        : DEFAULT_VAPID_SUBJECT,
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
  };
}

function normalizeSubscription(raw: unknown): PushSubscriptionRecord | null {
  const sub = (raw ?? {}) as Partial<PushSubscriptionRecord>;
  if (
    typeof sub.endpoint !== "string" ||
    sub.endpoint.length === 0 ||
    typeof sub.p256dh !== "string" ||
    typeof sub.auth !== "string"
  ) {
    return null;
  }
  return {
    endpoint: sub.endpoint,
    email: typeof sub.email === "string" ? sub.email : "",
    p256dh: sub.p256dh,
    auth: sub.auth,
  };
}

function normalizeNoteState(raw: unknown): NoteNotifyState | null {
  const state = (raw ?? {}) as Partial<NoteNotifyState>;
  if (
    typeof state.lastChangedAt !== "number" ||
    typeof state.lastNotifiedAt !== "number"
  ) {
    return null;
  }
  return {
    lastChangedAt: state.lastChangedAt,
    lastNotifiedAt: state.lastNotifiedAt,
    pending: state.pending === true,
    editors: Array.isArray(state.editors)
      ? state.editors.filter(
          (email): email is string => typeof email === "string",
        )
      : [],
    title: typeof state.title === "string" ? state.title : "",
  };
}

function vapidFromEnv(): VapidDetails | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return {
    subject: process.env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT,
    publicKey,
    privateKey,
  };
}

export async function initPush(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const obj = (parsed ?? {}) as Partial<PushData>;
    const notes: Record<string, NoteNotifyState> = {};
    if (obj.notes && typeof obj.notes === "object") {
      for (const [id, value] of Object.entries(obj.notes)) {
        const state = normalizeNoteState(value);
        if (state) notes[id] = state;
      }
    }
    data = {
      vapid: normalizeVapid(obj.vapid),
      subscriptions: Array.isArray(obj.subscriptions)
        ? obj.subscriptions.map(normalizeSubscription).filter((s) => s !== null)
        : [],
      notes,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    data = { vapid: null, subscriptions: [], notes: {} };
  }
  // Explicit env keys always win. Otherwise reuse the stored pair so existing
  // browser subscriptions keep working across restarts, generating and
  // persisting one on first boot.
  const fromEnv = vapidFromEnv();
  if (fromEnv) {
    data.vapid = fromEnv;
  } else if (!data.vapid) {
    data.vapid = {
      subject: process.env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT,
      ...webpush.generateVAPIDKeys(),
    };
    await persist();
  }
  loaded = true;
}

export function getVapid(): VapidDetails | null {
  return data.vapid;
}

export function listSubscriptions(): PushSubscriptionRecord[] {
  return data.subscriptions;
}

export function upsertSubscription(
  email: string,
  endpoint: string,
  p256dh: string,
  auth: string,
): Promise<void> {
  const existing = data.subscriptions.find((s) => s.endpoint === endpoint);
  if (existing) {
    existing.email = email;
    existing.p256dh = p256dh;
    existing.auth = auth;
  } else {
    data.subscriptions.push({ endpoint, email, p256dh, auth });
  }
  return persist();
}

export function removeSubscription(endpoint: string): Promise<void> {
  const kept = data.subscriptions.filter((s) => s.endpoint !== endpoint);
  if (kept.length === data.subscriptions.length) return Promise.resolve();
  data.subscriptions = kept;
  return persist();
}

export function persistedNoteNotifyStates(): Record<string, NoteNotifyState> {
  return data.notes;
}

export function saveNoteNotifyState(
  id: string,
  state: NoteNotifyState,
): Promise<void> {
  data.notes[id] = {
    lastChangedAt: state.lastChangedAt,
    lastNotifiedAt: state.lastNotifiedAt,
    pending: state.pending,
    editors: [...state.editors],
    title: state.title,
  };
  return persist();
}

export function forgetNoteNotifyState(id: string): Promise<void> {
  if (!(id in data.notes)) return Promise.resolve();
  delete data.notes[id];
  return persist();
}
