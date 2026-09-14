import type { Note } from "./api";

export type PendingStatus = "pending" | "conflicted";

export interface PendingChange {
  id: string;
  content: string;
  baseVersion: number;
  status: PendingStatus;
  server: { content: string; version: number } | null;
  savedAt: string;
}

const STORAGE_KEY = "notes.pending-changes.v1";

function readServer(raw: unknown): PendingChange["server"] {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as { content?: unknown; version?: unknown };
  if (
    typeof candidate.content !== "string" ||
    typeof candidate.version !== "number"
  ) {
    return null;
  }
  return { content: candidate.content, version: candidate.version };
}

function read(): Record<string, PendingChange> {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const changes: Record<string, PendingChange> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value !== "object" || value === null) continue;
      const candidate = value as Partial<PendingChange>;
      if (typeof candidate.content !== "string") continue;
      changes[id] = {
        id,
        content: candidate.content,
        baseVersion:
          typeof candidate.baseVersion === "number" ? candidate.baseVersion : 0,
        status: candidate.status === "conflicted" ? "conflicted" : "pending",
        server: readServer(candidate.server),
        savedAt:
          typeof candidate.savedAt === "string"
            ? candidate.savedAt
            : new Date(0).toISOString(),
      };
    }
    return changes;
  } catch {
    return {};
  }
}

function write(changes: Record<string, PendingChange>): void {
  try {
    if (Object.keys(changes).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(changes));
    }
  } catch {
    // Storage can be unavailable (private browsing, quota). In that case the
    // pending change stays in memory, which is the previous behaviour.
  }
}

export function loadPendingChanges(): PendingChange[] {
  return Object.values(read());
}

export function savePendingChange(change: PendingChange): void {
  const changes = read();
  changes[change.id] = { ...change, savedAt: new Date().toISOString() };
  write(changes);
}

export function clearPendingChange(id: string): void {
  const changes = read();
  if (!(id in changes)) return;
  delete changes[id];
  write(changes);
}

export function mergePendingChanges(
  notes: Note[],
  changes: PendingChange[],
): Note[] {
  if (changes.length === 0) return notes;
  const byId = new Map(changes.map((change) => [change.id, change]));
  return notes.map((note) => {
    const change = byId.get(note.id);
    return change ? { ...note, content: change.content } : note;
  });
}
