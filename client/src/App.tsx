import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AlertTriangle, Globe, Lock } from "lucide-react";
import { api, ApiError, type Note } from "./api";
import {
  clearPendingChange,
  loadPendingChanges,
  mergePendingChanges,
  type PendingChange,
  savePendingChange,
} from "./pendingChanges";

const MarkdownEditor = lazy(() => import("./components/MarkdownEditor"));

const SAVE_DELAY_MS = 800;
const REFRESH_INTERVAL_MS = 15000;

type SaveStatus = "idle" | "saving" | "saved" | "offline" | "error";
type Pane = "list" | "editor";

function stripMarkdown(line: string): string {
  return line
    .replace(/\[sticker\b[^\]]*\]/gi, "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}>\s?/, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/(\*\*|__|\*|_|`|~~)/g, "")
    .trim();
}

function titleFor(content: string): string {
  const firstLine = content.split("\n").find((line) => line.trim().length > 0);
  const title = firstLine ? stripMarkdown(firstLine) : "";
  return title.slice(0, 60) || "Untitled note";
}

function previewFor(content: string): string {
  const rest = content
    .split("\n")
    .slice(1)
    .map((line) => stripMarkdown(line))
    .filter((line) => line.length > 0)
    .join(" ");
  return rest.slice(0, 80);
}

export default function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [loading, setLoading] = useState(true);
  const [pane, setPane] = useState<Pane>("list");
  const [email, setEmail] = useState<string | null>(null);
  const [conflictedIds, setConflictedIds] = useState<Set<string>>(new Set());
  const [editorRevision, setEditorRevision] = useState(0);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Map<string, PendingChange>>(new Map());
  const flushing = useRef(false);
  const refreshing = useRef(false);

  const notesRef = useRef(notes);
  const selectedIdRef = useRef(selectedId);
  const draftRef = useRef(draft);
  useEffect(() => {
    notesRef.current = notes;
    selectedIdRef.current = selectedId;
    draftRef.current = draft;
  });

  const bumpRevision = useCallback(() => {
    setEditorRevision((revision) => revision + 1);
  }, []);

  const dropConflicted = useCallback((id: string) => {
    setConflictedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const hasActivePending = useCallback(
    () =>
      Array.from(pending.current.values()).some(
        (change) => change.status === "pending",
      ),
    [],
  );

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (flushing.current) return;
    flushing.current = true;
    try {
      // Keep going until every pending change is either uploaded, quarantined
      // or fails, so a flaky connection does not block a later edit.
      while (pending.current.size > 0) {
        const entries = Array.from(pending.current.entries());
        let progressed = false;
        for (const [id, change] of entries) {
          if (change.status === "conflicted") continue;
          if (pending.current.get(id) !== change) continue;
          try {
            const updated = await api.update(
              id,
              change.content,
              change.baseVersion,
            );
            const queued = pending.current.get(id);
            if (queued === change) {
              pending.current.delete(id);
              clearPendingChange(id);
            } else if (queued && queued.status === "pending") {
              // A newer edit was queued while this save was in flight and
              // captured the pre-save version. Rebase it onto the version just
              // written, otherwise its own save would falsely conflict.
              queued.baseVersion = updated.version;
              savePendingChange(queued);
            }
            setNotes((prev) =>
              prev.map((note) =>
                note.id === id
                  ? {
                      ...updated,
                      content:
                        pending.current.get(id)?.content ?? updated.content,
                    }
                  : note,
              ),
            );
            progressed = true;
          } catch (error) {
            // The note was deleted elsewhere, so there is nothing to sync.
            if (error instanceof ApiError && error.status === 404) {
              pending.current.delete(id);
              clearPendingChange(id);
              setConflictedIds((prev) => {
                if (!prev.has(id)) return prev;
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
              progressed = true;
            } else if (
              error instanceof ApiError &&
              error.status === 409 &&
              error.body
            ) {
              // The server copy moved on. Keep the local edit but never send
              // it again until the user resolves the conflict explicitly.
              const server = error.body as Note;
              if (pending.current.get(id) === change) {
                change.status = "conflicted";
                change.server = {
                  content: server.content,
                  version: server.version,
                };
                savePendingChange(change);
                setConflictedIds((prev) => new Set(prev).add(id));
              }
              setNotes((prev) =>
                prev.map((note) =>
                  note.id === id ? { ...note, version: server.version } : note,
                ),
              );
              progressed = true;
            }
            // Any other failure leaves the change in `pending` and in local
            // storage so it is retried when the connection recovers.
          }
        }
        if (!progressed) break;
      }
    } finally {
      flushing.current = false;
    }
    const active = Array.from(pending.current.values()).some(
      (change) => change.status === "pending",
    );
    setStatus(active ? "offline" : "saved");
  }, []);

  const scheduleSave = useCallback(
    (id: string, content: string) => {
      const existing = pending.current.get(id);
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
        baseVersion:
          existing?.baseVersion ??
          notesRef.current.find((note) => note.id === id)?.version ??
          0,
        status: "pending",
        server: existing?.server ?? null,
        savedAt: new Date().toISOString(),
      };
      pending.current.set(id, change);
      // Persist before the upload attempt so the edit survives a reload even if
      // the connection is too poor to save it to the server.
      savePendingChange(change);
      setStatus("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void flush();
      }, SAVE_DELAY_MS);
    },
    [flush],
  );

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const list = await api.list();
      const selected = selectedIdRef.current;
      // Only push remote content into the open editor when the note has no
      // local edit, otherwise refreshing would stomp what is being typed.
      if (selected && !pending.current.has(selected)) {
        const remote = list.find((note) => note.id === selected);
        if (remote && remote.content !== draftRef.current) {
          setDraft(remote.content);
          bumpRevision();
        }
      }
      setNotes(
        list.map((note) => {
          const change = pending.current.get(note.id);
          return change ? { ...note, content: change.content } : note;
        }),
      );
    } catch {
      // Keep the current state; the next focus or interval retries.
    } finally {
      refreshing.current = false;
    }
  }, [bumpRevision]);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then(({ email: current }) => {
        if (!cancelled) setEmail(current);
      })
      .catch(() => {});
    api
      .list()
      .then((list) => {
        if (cancelled) return;
        const stored = loadPendingChanges();
        for (const change of stored) {
          pending.current.set(change.id, change);
        }
        const conflicted = stored.filter(
          (change) => change.status === "conflicted",
        );
        if (conflicted.length > 0) {
          setConflictedIds(new Set(conflicted.map((change) => change.id)));
        }
        const merged = mergePendingChanges(list, stored);
        setNotes(merged);
        const first = merged[0];
        if (first) {
          setSelectedId(first.id);
          setDraft(first.content);
        }
        if (stored.some((change) => change.status === "pending")) {
          void flush();
        }
      })
      .catch(() => setStatus("error"))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [flush]);

  useEffect(() => {
    function handleOnline() {
      void flush();
    }
    function handleWake() {
      if (document.visibilityState !== "visible") return;
      void flush();
      void refresh();
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("focus", handleWake);
    document.addEventListener("visibilitychange", handleWake);
    const retry = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (pending.current.size > 0) void flush();
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("focus", handleWake);
      document.removeEventListener("visibilitychange", handleWake);
      window.clearInterval(retry);
    };
  }, [flush, refresh]);

  useEffect(() => {
    return () => {
      void flush();
    };
  }, [flush]);

  function handleChange(value: string) {
    setDraft(value);
    if (!selectedId) return;
    setNotes((prev) =>
      prev.map((note) =>
        note.id === selectedId ? { ...note, content: value } : note,
      ),
    );
    scheduleSave(selectedId, value);
  }

  async function selectNote(id: string) {
    if (id !== selectedId) await flush();

    const change = pending.current.get(id);
    let content: string | undefined;
    let resetEditor = false;

    if (change?.status === "conflicted") {
      const discard = window.confirm(
        "This note changed elsewhere. Discard your changes and load the latest?",
      );
      if (discard) {
        try {
          const latest = await api.get(id);
          pending.current.delete(id);
          clearPendingChange(id);
          dropConflicted(id);
          setNotes((prev) =>
            prev.map((note) => (note.id === id ? latest : note)),
          );
          content = latest.content;
          resetEditor = true;
        } catch {
          setStatus("error");
          return;
        }
      } else {
        content = change.content;
      }
    } else {
      const note = notes.find((n) => n.id === id);
      if (!note) return;
      content = note.content;
    }

    if (id === selectedId) {
      if (resetEditor) {
        setDraft(content ?? "");
        bumpRevision();
      }
    } else {
      setSelectedId(id);
      setDraft(content ?? "");
      setStatus(hasActivePending() ? "offline" : "idle");
    }
    setPane("editor");
  }

  async function createNote() {
    await flush();
    try {
      const note = await api.create("");
      setNotes((prev) => [note, ...prev]);
      setSelectedId(note.id);
      setDraft(note.content);
      setStatus(hasActivePending() ? "offline" : "idle");
      setPane("editor");
    } catch {
      setStatus("error");
    }
  }

  async function removeNote(id: string) {
    if (!window.confirm("Delete this note?")) return;
    if (pending.current.has(id)) {
      pending.current.delete(id);
      clearPendingChange(id);
      dropConflicted(id);
      if (timer.current) clearTimeout(timer.current);
    }
    try {
      await api.remove(id);
    } catch {
      setStatus("error");
      return;
    }
    setNotes((prev) => {
      const next = prev.filter((note) => note.id !== id);
      if (selectedId === id) {
        const first = next[0];
        setSelectedId(first?.id ?? null);
        setDraft(first?.content ?? "");
        setStatus(hasActivePending() ? "offline" : "idle");
        setPane("list");
      }
      return next;
    });
  }

  async function toggleVisibility() {
    const note = notes.find((n) => n.id === selectedId);
    if (!note) return;
    const visibility = note.visibility === "private" ? "public" : "private";
    try {
      const updated = await api.setVisibility(note.id, visibility);
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
    } catch {
      setStatus("error");
    }
  }

  const selectedNote = notes.find((note) => note.id === selectedId);
  const selectedConflicted =
    selectedId != null && conflictedIds.has(selectedId);
  const canToggle =
    selectedNote != null &&
    (selectedNote.owner === "" || selectedNote.owner === email);

  return (
    <div className="flex h-dvh bg-white text-slate-900" data-pane={pane}>
      <aside
        className={`flex min-w-0 flex-1 flex-col bg-white md:flex-none md:basis-[300px] md:border-r md:border-slate-200 ${
          pane === "editor" ? "max-md:hidden" : ""
        }`}
      >
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] md:pt-4">
          <h1 className="m-0 text-xl font-semibold">Notes</h1>
          <button
            type="button"
            className="min-h-10 rounded-lg bg-slate-900 px-4 py-2 text-[0.9375rem] font-medium text-white hover:bg-slate-700 active:bg-slate-700"
            onClick={createNote}
          >
            New
          </button>
        </header>

        {loading ? (
          <p className="p-4 text-slate-500">Loading…</p>
        ) : notes.length === 0 ? (
          <p className="p-4 text-slate-500">No notes yet</p>
        ) : (
          <ul className="m-0 flex-1 list-none overflow-y-auto p-0">
            {notes.map((note) => (
              <li key={note.id} className="relative border-b border-slate-100">
                <button
                  type="button"
                  className={`flex min-h-16 w-full flex-col gap-0.5 py-3 pl-4 pr-14 text-left ${
                    note.id === selectedId ? "bg-slate-100" : ""
                  }`}
                  onClick={() => void selectNote(note.id)}
                >
                  <span className="flex items-center gap-1.5 font-semibold">
                    {note.visibility === "public" && (
                      <Globe
                        size={14}
                        className="flex-none text-slate-400"
                        aria-hidden="true"
                      />
                    )}
                    {conflictedIds.has(note.id) && (
                      <AlertTriangle
                        size={14}
                        className="flex-none text-amber-500"
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate">{titleFor(note.content)}</span>
                  </span>
                  <span className="truncate text-sm text-slate-500">
                    {previewFor(note.content)}
                  </span>
                </button>
                <button
                  type="button"
                  className="absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-xl leading-none text-slate-500 hover:bg-slate-100 hover:text-red-600 active:bg-slate-100 active:text-red-600"
                  aria-label="Delete note"
                  onClick={() => void removeNote(note.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <main
        className={`flex min-w-0 flex-1 flex-col ${
          pane === "list" ? "max-md:hidden" : ""
        }`}
      >
        {selectedId ? (
          <>
            <header className="flex min-h-12 items-center gap-3 px-4 pb-1 pt-[calc(0.25rem+env(safe-area-inset-top))] md:min-h-10 md:pt-3">
              <button
                type="button"
                className="-ml-3 flex h-11 w-11 items-center justify-center rounded-lg text-xl leading-none hover:bg-slate-100 active:bg-slate-100 md:hidden"
                aria-label="Back to notes"
                onClick={() => setPane("list")}
              >
                ←
              </button>
              <div className="ml-auto flex items-center gap-3">
                <button
                  type="button"
                  className="flex h-9 flex-none items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-[0.8125rem] font-medium text-slate-700 hover:bg-slate-100 active:bg-slate-100 disabled:opacity-40"
                  onClick={() => void toggleVisibility()}
                  disabled={!canToggle}
                  aria-pressed={selectedNote?.visibility === "public"}
                  title={
                    selectedNote?.visibility === "public"
                      ? "Public — visible to everyone with access"
                      : "Private — only you can see this note"
                  }
                >
                  {selectedNote?.visibility === "public" ? (
                    <Globe size={16} />
                  ) : (
                    <Lock size={16} />
                  )}
                  {selectedNote?.visibility === "public" ? "Public" : "Private"}
                </button>
                <span
                  className={`text-[0.8125rem] ${
                    selectedConflicted
                      ? "text-amber-600"
                      : status === "error"
                        ? "text-red-600"
                        : status === "offline"
                          ? "text-amber-600"
                          : "text-slate-500"
                  }`}
                  aria-live="polite"
                >
                  {selectedConflicted
                    ? "Changed elsewhere"
                    : status === "saving"
                      ? "Saving…"
                      : status === "saved"
                        ? "Saved"
                        : status === "offline"
                          ? "Saved on device"
                          : status === "error"
                            ? "Save failed"
                            : ""}
                </span>
              </div>
            </header>
            <Suspense
              fallback={<p className="p-4 text-slate-500">Loading editor…</p>}
            >
              <MarkdownEditor
                noteId={selectedId}
                initialMarkdown={draft}
                userEmail={email}
                revision={editorRevision}
                onChange={handleChange}
              />
            </Suspense>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-slate-500">
            Select a note or create a new one
          </div>
        )}
      </main>
    </div>
  );
}
