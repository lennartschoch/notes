import { api, ApiError, type Note } from "./api";
import {
  clearPendingChange,
  loadPendingChanges,
  savePendingChange,
  type PendingChange,
} from "./pendingChanges";

// The offline-first sync engine, kept free of React. It owns the unsent
// edits, the debounced upload loop, the version rebasing, and the quarantine
// of edits that lost a version race. The UI reports edits through schedule()
// and renders what the events describe; nothing else touches pendingChanges.
//
// Auto-save writes on every keystroke pause, so an edit is uploaded only
// after SAVE_DELAY_MS of quiet; a failed upload stays queued and in local
// storage until the connection (or a retry tick) comes back.

const SAVE_DELAY_MS = 800;

export type SyncStatus = "saving" | "offline" | "saved";

export interface SyncQueueEvents {
  // An upload landed. displayContent keeps showing a newer queued edit
  // while it waits for its own turn.
  saved(note: Note, displayContent: string): void;
  // The server copy moved on: the local edit stays visible but is never
  // sent again until the user resolves the conflict explicitly.
  conflicted(id: string): void;
  // The server reports a newer version for the note.
  noteVersion(id: string, version: number): void;
  // The note was deleted elsewhere; there is nothing left to sync.
  gone(id: string): void;
  status(status: SyncStatus): void;
}

export interface SyncQueue {
  schedule(id: string, content: string, fallbackVersion: number): void;
  flush(): Promise<void>;
  restore(): PendingChange[];
  get(id: string): PendingChange | undefined;
  has(id: string): boolean;
  drop(id: string): void;
  hasActive(): boolean;
}

export function createSyncQueue(events: SyncQueueEvents): SyncQueue {
  const pending = new Map<string, PendingChange>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;

  function hasActive(): boolean {
    return Array.from(pending.values()).some(
      (change) => change.status === "pending",
    );
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (flushing) return;
    flushing = true;
    try {
      // Keep going until every pending change is either uploaded,
      // quarantined or fails, so a flaky connection does not block a later
      // edit.
      while (pending.size > 0) {
        const entries = Array.from(pending.entries());
        let progressed = false;
        for (const [id, change] of entries) {
          if (change.status === "conflicted") continue;
          if (pending.get(id) !== change) continue;
          try {
            const updated = await api.update(
              id,
              change.content,
              change.baseVersion,
            );
            const queued = pending.get(id);
            if (queued === change) {
              pending.delete(id);
              clearPendingChange(id);
            } else if (queued && queued.status === "pending") {
              // A newer edit was queued while this save was in flight and
              // captured the pre-save version. Rebase it onto the version
              // just written, otherwise its own save would falsely conflict.
              queued.baseVersion = updated.version;
              savePendingChange(queued);
            }
            events.saved(updated, pending.get(id)?.content ?? updated.content);
            progressed = true;
          } catch (error) {
            // The note was deleted elsewhere, so there is nothing to sync.
            if (error instanceof ApiError && error.status === 404) {
              pending.delete(id);
              clearPendingChange(id);
              events.gone(id);
              progressed = true;
            } else if (
              error instanceof ApiError &&
              error.status === 409 &&
              error.body
            ) {
              // The server copy moved on. Keep the local edit but never send
              // it again until the user resolves the conflict explicitly.
              const server = error.body as Note;
              if (pending.get(id) === change) {
                change.status = "conflicted";
                change.server = {
                  content: server.content,
                  version: server.version,
                };
                savePendingChange(change);
                events.conflicted(id);
              }
              events.noteVersion(id, server.version);
              progressed = true;
            }
            // Any other failure leaves the change in `pending` and in local
            // storage so it is retried when the connection recovers.
          }
        }
        if (!progressed) break;
      }
    } finally {
      flushing = false;
    }
    events.status(hasActive() ? "offline" : "saved");
  }

  function schedule(
    id: string,
    content: string,
    fallbackVersion: number,
  ): void {
    const existing = pending.get(id);
    // A quarantined note stays quarantined: keep the latest text locally so
    // the user can recover it, but do not queue another upload.
    if (existing?.status === "conflicted") {
      existing.content = content;
      savePendingChange(existing);
      return;
    }
    const change: PendingChange = {
      id,
      content,
      baseVersion: existing?.baseVersion ?? fallbackVersion,
      status: "pending",
      server: existing?.server ?? null,
      savedAt: new Date().toISOString(),
    };
    pending.set(id, change);
    // Persist before the upload attempt so the edit survives a reload even
    // if the connection is too poor to save it to the server.
    savePendingChange(change);
    events.status("saving");
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, SAVE_DELAY_MS);
  }

  // Re-adopts the changes a previous page load left in local storage.
  function restore(): PendingChange[] {
    const stored = loadPendingChanges();
    for (const change of stored) pending.set(change.id, change);
    return stored;
  }

  function drop(id: string): void {
    if (!pending.has(id)) return;
    pending.delete(id);
    clearPendingChange(id);
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    schedule,
    flush,
    restore,
    get: (id) => pending.get(id),
    has: (id) => pending.has(id),
    drop,
    hasActive,
  };
}
