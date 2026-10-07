import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
import { z } from "zod";

const currentDir = dirname(fileURLToPath(import.meta.url));
// Follow the notes store onto whatever volume NOTES_DATA_FILE points at, so
// the subscriptions and VAPID keys survive a redeploy without a second path to
// keep in sync.
const NOTES_DATA_FILE =
  process.env.NOTES_DATA_FILE ?? join(currentDir, "..", "data", "notes.json");
const DATA_FILE =
  process.env.PUSH_DATA_FILE ?? join(dirname(NOTES_DATA_FILE), "push.json");
const DEFAULT_VAPID_SUBJECT = "mailto:notes@localhost";

// The shapes stored in push.json, tolerant in the same way as the note
// store's schema: a field that cannot be read falls back to its default, a
// record whose essentials are broken is dropped on load.
const vapidSchema = z.object({
  subject: z.string().min(1).catch(DEFAULT_VAPID_SUBJECT),
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
});
export type VapidDetails = z.infer<typeof vapidSchema>;

const subscriptionSchema = z.object({
  endpoint: z.string().min(1),
  email: z.string().catch(""),
  p256dh: z.string(),
  auth: z.string(),
});
export type PushSubscriptionRecord = z.infer<typeof subscriptionSchema>;

// Notification-scheduler state that must survive a restart: whether changes
// are still waiting for their quiet period and when the last notification
// went out (the cooldown anchor).
const noteNotifyStateSchema = z.object({
  lastChangedAt: z.number(),
  lastNotifiedAt: z.number(),
  pending: z.boolean().catch(false),
  editors: z
    .unknown()
    .transform((value) =>
      Array.isArray(value)
        ? value.filter((email): email is string => typeof email === "string")
        : [],
    ),
  title: z.string().catch(""),
});
export type NoteNotifyState = z.infer<typeof noteNotifyStateSchema>;

function parseSchema<S extends z.ZodType>(
  schema: S,
  raw: unknown,
): z.infer<S> | null {
  const parsed = schema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : null;
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
        const state = parseSchema(noteNotifyStateSchema, value);
        if (state) notes[id] = state;
      }
    }
    data = {
      vapid: parseSchema(vapidSchema, obj.vapid),
      subscriptions: Array.isArray(obj.subscriptions)
        ? obj.subscriptions
            .map((sub) => parseSchema(subscriptionSchema, sub))
            .filter((sub) => sub !== null)
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
