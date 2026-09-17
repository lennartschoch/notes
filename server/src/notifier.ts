import webpush from "web-push";
import {
  forgetNoteNotifyState,
  getVapid,
  listSubscriptions,
  persistedNoteNotifyStates,
  removeSubscription,
  saveNoteNotifyState,
} from "./pushStore.js";
import { peekNote } from "./store.js";
import type { Note } from "./types.js";

// Auto-save writes on every pause in typing, so a change never notifies
// immediately: the note must be quiet for PUSH_QUIET_MS first (default five
// minutes), which collapses an editing session into a single notification.
// Once one goes out, PUSH_COOLDOWN_MS (default one hour) begins: changes made
// during the cooldown are dropped without notifying, and the next change
// after the cooldown starts a fresh quiet period. Both overrides exist for
// tests.
const QUIET_MS = Number(process.env.PUSH_QUIET_MS ?? 5 * 60 * 1000);
const COOLDOWN_MS = Number(process.env.PUSH_COOLDOWN_MS ?? 60 * 60 * 1000);
const SEND_TIMEOUT_MS = 10_000;

interface LiveState {
  lastChangedAt: number;
  lastNotifiedAt: number;
  pending: boolean;
  editors: string[];
  title: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const states = new Map<string, LiveState>();

function snapshot(state: LiveState) {
  return {
    lastChangedAt: state.lastChangedAt,
    lastNotifiedAt: state.lastNotifiedAt,
    pending: state.pending,
    editors: [...state.editors],
    title: state.title,
  };
}

function noteTitle(content: string): string {
  const firstLine = content.split("\n").find((line) => line.trim().length > 0);
  const title = (firstLine ?? "")
    .replace(/\[sticker\b[^\]]*\]/gi, "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .trim();
  return title.slice(0, 60) || "Untitled note";
}

// Re-arms the timers for changes that were pending when the server stopped.
export function initNotifier(): void {
  for (const [id, saved] of Object.entries(persistedNoteNotifyStates())) {
    const state: LiveState = { ...saved, timer: null };
    states.set(id, state);
    if (state.pending) arm(id, state);
  }
}

export function scheduleNoteChange(note: Note, editorEmail: string): void {
  const existing = states.get(note.id);
  if (existing && Date.now() < existing.lastNotifiedAt + COOLDOWN_MS) {
    // Inside the cooldown that started with the last notification: this
    // change is dropped. The next change after the cooldown expires will
    // start a fresh quiet period.
    return;
  }
  let state = existing;
  if (!state) {
    state = {
      lastChangedAt: 0,
      lastNotifiedAt: 0,
      pending: false,
      editors: [],
      title: "",
      timer: null,
    };
    states.set(note.id, state);
  }
  state.lastChangedAt = Date.now();
  state.pending = true;
  state.title = noteTitle(note.content);
  if (editorEmail && !state.editors.includes(editorEmail)) {
    state.editors.push(editorEmail);
  }
  arm(note.id, state);
  void saveNoteNotifyState(note.id, snapshot(state));
}

export function noteRemoved(id: string): void {
  const state = states.get(id);
  if (state?.timer) clearTimeout(state.timer);
  states.delete(id);
  void forgetNoteNotifyState(id);
}

function arm(id: string, state: LiveState): void {
  if (state.timer) clearTimeout(state.timer);
  const due = state.lastChangedAt + QUIET_MS;
  state.timer = setTimeout(() => void fire(id), Math.max(0, due - Date.now()));
  // The timer should not keep the process alive during shutdown.
  state.timer.unref();
}

async function fire(id: string): Promise<void> {
  const state = states.get(id);
  if (!state) return;
  state.timer = null;
  if (!state.pending) return;
  // A change can slip in while a previous notification is being sent (the
  // cooldown only starts once delivery finishes). Its quiet period belongs to
  // the notification that just went out, so drop it.
  if (Date.now() < state.lastNotifiedAt + COOLDOWN_MS) {
    state.pending = false;
    state.editors = [];
    void saveNoteNotifyState(id, snapshot(state));
    return;
  }
  if (Date.now() - state.lastChangedAt < QUIET_MS) {
    arm(id, state);
    return;
  }
  const note = peekNote(id);
  // The note disappeared or went private while the notification was pending.
  if (!note || note.visibility !== "public") {
    state.pending = false;
    state.editors = [];
    void saveNoteNotifyState(id, snapshot(state));
    return;
  }
  const editors = [...state.editors];
  const delivered = await deliver(note, state.title, editors);
  const current = states.get(id);
  if (!current) return; // note deleted while sending
  if (delivered) current.lastNotifiedAt = Date.now();
  // Anything that changed during delivery is dropped along with this batch;
  // the next change starts a fresh quiet period (after the cooldown, if the
  // notification went out).
  current.pending = false;
  current.editors = [];
  void saveNoteNotifyState(id, snapshot(current));
}

async function deliver(
  note: Note,
  title: string,
  editors: string[],
): Promise<boolean> {
  const recipients = listSubscriptions().filter(
    (sub) => !editors.includes(sub.email),
  );
  if (recipients.length === 0) return false;
  const vapid = getVapid();
  if (vapid) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }
  const first = editors[0] ?? "someone";
  const body =
    editors.length > 1
      ? `Updated by ${first} and ${editors.length - 1} others`
      : `Updated by ${first}`;
  const payload = JSON.stringify({
    title: title || "Note updated",
    body,
    tag: `note-${note.id}`,
  });
  await Promise.all(
    recipients.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
          { timeout: SEND_TIMEOUT_MS },
        );
      } catch (err) {
        // 404/410 mean the subscription expired at the push service.
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          void removeSubscription(sub.endpoint);
        } else {
          console.warn(
            `push delivery to ${sub.email} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }),
  );
  return true;
}
