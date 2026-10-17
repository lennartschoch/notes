import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangle, Bell, BellOff, Bot, Globe, Lock } from "lucide-react";
import {
  noteTitle,
  presenceKey,
  type LiveCursor,
  type LiveEditor,
} from "shared";
import { api, type Note } from "./api";
import { caretLabel } from "./carets";
import { createLive, idleLiveHandlers, type LiveStatus } from "./live";
import { mergePendingChanges } from "./pendingChanges";
import { createSyncQueue, type SyncQueueEvents } from "./syncQueue";
import {
  disablePush,
  enablePush,
  pushSupported,
  registerServiceWorker,
  resyncPushSubscription,
} from "./push";

const MarkdownEditor = lazy(() => import("./components/MarkdownEditor"));

const REFRESH_INTERVAL_MS = 15000;

type SaveStatus = "idle" | "saving" | "saved" | "offline" | "error";
type Pane = "list" | "editor";

function stripMarkdown(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}>\s?/, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/(\*\*|__|\*|_|`|~~)/g, "")
    .trim();
}

// Sidebar preview: the body under the title line. The title itself comes
// from shared/noteText so it matches push notifications and MCP output.
function previewFor(content: string): string {
  const rest = content
    .split("\n")
    .slice(1)
    .map((line) => stripMarkdown(line))
    .filter((line) => line.length > 0)
    .join(" ");
  return rest.slice(0, 80);
}

// Placeholder events for the queue's first render. Nothing can sync before
// mount, and the real handlers arrive in the first effect.
const idleEvents: SyncQueueEvents = {
  saved: () => {},
  conflicted: () => {},
  noteVersion: () => {},
  gone: () => {},
  status: () => {},
};

// How long a keystroke keeps the tab marked "editing" for the other peers.
const TYPING_IDLE_MS = 4000;

// A peer is identified by their email (plus whether an agent drives them); the
// chip shows a compact tag, or a robot mark for an agent so it never looks like
// the person typed it themselves.
function initialsFor(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local.slice(0, 2).toUpperCase();
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
  const [pushEnabled, setPushEnabled] = useState(false);
  const [liveEditors, setLiveEditors] = useState<Record<string, LiveEditor[]>>(
    {},
  );
  // Where each peer's caret is, per note. Purely ephemeral: nothing is
  // drawn from it until a second tab is in the same note.
  const [liveCarets, setLiveCarets] = useState<Record<string, LiveCursor[]>>(
    {},
  );
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("connecting");

  const refreshing = useRef(false);
  const typingIdle = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The last text the server confirmed for each note, with its version. The
  // visible list can carry unsaved local content, so the merge base an edit
  // descends from has to be remembered apart from what is on screen.
  const serverTruth = useRef(
    new Map<string, { content: string; version: number }>(),
  );
  const rememberServer = useCallback((list: Note[]) => {
    for (const note of list) {
      serverTruth.current.set(note.id, {
        content: note.content,
        version: note.version,
      });
    }
  }, []);

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

  // A save landed: remember the server truth, update the list, and pull a
  // server-side merge into the open editor when nothing newer is queued
  // waiting behind it.
  const saveLanded = useCallback(
    (note: Note, displayContent: string) => {
      serverTruth.current.set(note.id, {
        content: note.content,
        version: note.version,
      });
      setNotes((prev) =>
        prev.map((n) =>
          n.id === note.id ? { ...note, content: displayContent } : n,
        ),
      );
      // The server may have merged this save with someone else's text. When
      // nothing newer is queued, that merged text is the truth the next
      // keystroke edits, so pull it into the open editor.
      if (
        selectedIdRef.current === note.id &&
        displayContent === note.content &&
        draftRef.current !== note.content
      ) {
        setDraft(note.content);
        bumpRevision();
      }
    },
    [bumpRevision],
  );

  // The offline sync engine, created once and surviving every re-render.
  // Its handlers read refs (the draft, the selection, the server truth), so
  // they are handed over from an effect rather than captured at render.
  const queue = useMemo(() => createSyncQueue(idleEvents), []);

  // The live socket, created once; its handlers arrive from an effect for
  // the same ref-safety reason as the sync queue's.
  const live = useMemo(() => createLive(idleLiveHandlers), []);

  useEffect(() => {
    queue.setEvents({
      saved: saveLanded,
      conflicted: (id) => setConflictedIds((prev) => new Set(prev).add(id)),
      noteVersion: (id, version) =>
        setNotes((prev) =>
          prev.map((n) => (n.id === id ? { ...n, version } : n)),
        ),
      gone: (id) =>
        setConflictedIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        }),
      status: (syncStatus) => setStatus(syncStatus),
    });
  }, [queue, saveLanded]);

  // What the live channel does with what it receives: fold remote note
  // snapshots into the list and the open editor, react to notes vanishing,
  // and keep the roster of peers for the presence chips.
  useEffect(() => {
    live.setHandlers({
      note: (remote) => {
        serverTruth.current.set(remote.id, {
          content: remote.content,
          version: remote.version,
        });
        setNotes((prev) => {
          const display = {
            ...remote,
            // A local edit still wins on screen; the queue owns that text.
            content: queue.get(remote.id)?.content ?? remote.content,
          };
          if (!prev.some((n) => n.id === remote.id)) {
            return [display, ...prev];
          }
          return prev.map((n) => (n.id === remote.id ? display : n));
        });
        if (
          selectedIdRef.current === remote.id &&
          !queue.has(remote.id) &&
          draftRef.current !== remote.content
        ) {
          setDraft(remote.content);
          bumpRevision();
        }
      },
      gone: (id) => {
        queue.drop(id);
        dropConflicted(id);
        setLiveEditors((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setLiveCarets((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setNotes((prev) => prev.filter((n) => n.id !== id));
        if (selectedIdRef.current === id) {
          setSelectedId(null);
          setDraft("");
          setStatus("idle");
          setPane("list");
        }
      },
      presence: (noteId, editors) => {
        // A peer is identified by account *and* whether an agent drives it, so
        // an agent acting as you is not mistaken for you. Only this tab's own
        // presence (this email, no agent) is noise to filter out.
        const me = presenceKey(email ?? "", false);
        const peers = editors.filter(
          (editor) => presenceKey(editor.email, editor.agent) !== me,
        );
        setLiveEditors((prev) => ({
          ...prev,
          // The roster includes this tab; a chip for yourself is noise.
          [noteId]: peers,
        }));
        // A peer can only have a caret if they are in the room; pruning here
        // sweeps up any clear that was missed while this tab was reconnecting.
        const stillHere = new Set(
          peers.map((peer) => presenceKey(peer.email, peer.agent)),
        );
        setLiveCarets((prev) => {
          const inNote = prev[noteId];
          if (!inNote) return prev;
          const kept = inNote.filter((caret) =>
            stillHere.has(presenceKey(caret.email, caret.agent)),
          );
          if (kept.length === inNote.length) return prev;
          return { ...prev, [noteId]: kept };
        });
      },
      cursor: (noteId, cursor) => {
        const cursorKey = presenceKey(cursor.email, cursor.agent);
        setLiveCarets((prev) => {
          const others = (prev[noteId] ?? []).filter(
            (caret) => presenceKey(caret.email, caret.agent) !== cursorKey,
          );
          return {
            ...prev,
            [noteId]: cursor.position === null ? others : [...others, cursor],
          };
        });
      },
      status: setLiveStatus,
    });
  }, [live, queue, bumpRevision, dropConflicted, email]);

  // Open the live channel once the identity is known, and follow the open
  // note: subscribe while it is selected, leave the room when it is not.
  useEffect(() => {
    if (!email) return;
    live.start(email);
  }, [live, email]);

  useEffect(() => {
    return () => {
      live.stop();
    };
  }, [live]);

  useEffect(() => {
    if (!selectedId) return;
    live.subscribe(selectedId);
    return () => {
      live.unsubscribe(selectedId);
      // Leaving the note leaves its carets behind; reopening fetches fresh
      // ones as peers keep editing.
      setLiveCarets((prev) => {
        if (!(selectedId in prev)) return prev;
        const next = { ...prev };
        delete next[selectedId];
        return next;
      });
    };
  }, [live, selectedId]);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const list = await api.list();
      rememberServer(list);
      const selected = selectedIdRef.current;
      // Only push remote content into the open editor when the note has no
      // local edit, otherwise refreshing would stomp what is being typed.
      if (selected && !queue.has(selected)) {
        const remote = list.find((note) => note.id === selected);
        if (remote && remote.content !== draftRef.current) {
          setDraft(remote.content);
          bumpRevision();
        }
      }
      setNotes(
        list.map((note) => {
          const change = queue.get(note.id);
          return change ? { ...note, content: change.content } : note;
        }),
      );
    } catch {
      // Keep the current state; the next focus or interval retries.
    } finally {
      refreshing.current = false;
    }
  }, [bumpRevision, queue, rememberServer]);

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
        rememberServer(list);
        const stored = queue.restore();
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
          void queue.flush();
        }
      })
      .catch(() => setStatus("error"))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queue, rememberServer]);

  useEffect(() => {
    function handleOnline() {
      void queue.flush();
    }
    function handleWake() {
      if (document.visibilityState !== "visible") return;
      void queue.flush();
      void refresh();
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("focus", handleWake);
    document.addEventListener("visibilitychange", handleWake);
    const retry = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (queue.hasActive()) void queue.flush();
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("focus", handleWake);
      document.removeEventListener("visibilitychange", handleWake);
      window.clearInterval(retry);
    };
  }, [queue, refresh]);

  useEffect(() => {
    return () => {
      void queue.flush();
    };
  }, [queue]);

  // Bring up the push service worker and re-register any existing browser
  // subscription so the server-side record tracks the current user.
  useEffect(() => {
    if (!pushSupported()) return;
    let cancelled = false;
    void registerServiceWorker()
      .then(() => resyncPushSubscription())
      .then((active) => {
        if (!cancelled) setPushEnabled(active);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function togglePush() {
    if (pushEnabled) {
      if (await disablePush()) setPushEnabled(false);
    } else {
      setPushEnabled(await enablePush());
    }
  }

  function handleChange(value: string) {
    setDraft(value);
    if (!selectedId) return;
    setNotes((prev) =>
      prev.map((note) =>
        note.id === selectedId ? { ...note, content: value } : note,
      ),
    );
    const server = serverTruth.current.get(selectedId);
    // A null version means the client has never seen this note's server
    // text; the queue asks the server where it stands before uploading,
    // instead of guessing version 0 and collecting a false conflict.
    queue.schedule(
      selectedId,
      value,
      server?.version ?? null,
      server?.content ?? null,
    );
    // Tell the other peers this tab is typing, and fall back to "viewing"
    // once the keystrokes stop.
    live.setPresence(selectedId, "editing");
    if (typingIdle.current) clearTimeout(typingIdle.current);
    typingIdle.current = setTimeout(() => {
      typingIdle.current = null;
      live.setPresence(selectedId, "viewing");
    }, TYPING_IDLE_MS);
  }

  // Resolve a conflict in the user's favour: re-read the server copy, then
  // re-arm the quarantined edit against that exact version. The upload
  // carries no merge base, so it overwrites what the user just saw — and
  // conflicts again, rather than clobbering, if someone moved ahead first.
  async function keepMine() {
    const id = selectedId;
    if (!id) return;
    try {
      const latest = await api.get(id);
      serverTruth.current.set(id, {
        content: latest.content,
        version: latest.version,
      });
      // Clear the banner before the upload so a fresh race during the save
      // can raise it again, and only then re-arm the quarantined edit.
      dropConflicted(id);
      setStatus("saving");
      await queue.resolveConflictKeep(id, latest.version);
    } catch {
      setStatus("error");
    }
  }

  async function selectNote(id: string) {
    if (id !== selectedId) await queue.flush();

    const change = queue.get(id);
    let content: string | undefined;
    let resetEditor = false;

    if (change?.status === "conflicted") {
      const discard = window.confirm(
        "This note changed elsewhere. Discard your changes and load the latest?",
      );
      if (discard) {
        try {
          const latest = await api.get(id);
          queue.drop(id);
          dropConflicted(id);
          serverTruth.current.set(id, {
            content: latest.content,
            version: latest.version,
          });
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
      setStatus(queue.hasActive() ? "offline" : "idle");
    }
    setPane("editor");
  }

  async function createNote() {
    await queue.flush();
    try {
      const note = await api.create("");
      serverTruth.current.set(note.id, {
        content: note.content,
        version: note.version,
      });
      setNotes((prev) => [note, ...prev]);
      setSelectedId(note.id);
      setDraft(note.content);
      setStatus(queue.hasActive() ? "offline" : "idle");
      setPane("editor");
    } catch {
      setStatus("error");
    }
  }

  async function removeNote(id: string) {
    if (!window.confirm("Delete this note?")) return;
    queue.drop(id);
    dropConflicted(id);
    try {
      await api.remove(id);
    } catch {
      setStatus("error");
      return;
    }
    // Computed from the rendered list rather than inside a setNotes updater:
    // updaters must be pure (StrictMode runs them twice), and selecting the
    // next note is not a notes-list concern anyway.
    const next = notes.filter((note) => note.id !== id);
    if (selectedId === id) {
      const first = next[0];
      setSelectedId(first?.id ?? null);
      setDraft(first?.content ?? "");
      setStatus(queue.hasActive() ? "offline" : "idle");
      setPane("list");
    }
    setNotes(next);
  }

  async function toggleVisibility() {
    const note = notes.find((n) => n.id === selectedId);
    if (!note) return;
    const visibility = note.visibility === "private" ? "public" : "private";
    try {
      const updated = await api.setVisibility(note.id, visibility);
      serverTruth.current.set(updated.id, {
        content: updated.content,
        version: updated.version,
      });
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
    } catch {
      setStatus("error");
    }
  }

  const selectedNote = notes.find((note) => note.id === selectedId);
  const peers = selectedId ? (liveEditors[selectedId] ?? []) : [];
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
          <div className="flex items-center gap-2">
            <span
              data-live-status={liveStatus}
              title={
                liveStatus === "online"
                  ? "Live sync connected — changes appear as they happen"
                  : liveStatus === "connecting"
                    ? "Connecting live sync…"
                    : "Live sync offline — edits still sync on save and refresh"
              }
              className={`h-2 w-2 flex-none rounded-full ${
                liveStatus === "online"
                  ? "bg-emerald-500"
                  : liveStatus === "connecting"
                    ? "bg-amber-400"
                    : "bg-slate-300"
              }`}
            />
            {pushSupported() && (
              <button
                type="button"
                className={`flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-100 active:bg-slate-100 ${
                  pushEnabled ? "text-slate-900" : "text-slate-500"
                }`}
                onClick={() => void togglePush()}
                aria-pressed={pushEnabled}
                aria-label="Note update notifications"
                title={
                  pushEnabled
                    ? "You will be notified when a shared note changes"
                    : "Notify me when a shared note changes"
                }
              >
                {pushEnabled ? <Bell size={18} /> : <BellOff size={18} />}
              </button>
            )}
            <button
              type="button"
              className="min-h-10 rounded-lg bg-slate-900 px-4 py-2 text-[0.9375rem] font-medium text-white hover:bg-slate-700 active:bg-slate-700"
              onClick={createNote}
            >
              New
            </button>
          </div>
        </header>

        {loading ? (
          <p className="p-4 text-slate-500">Loading…</p>
        ) : notes.length === 0 ? (
          <p className="p-4 text-slate-500">No notes yet</p>
        ) : (
          <ul className="m-0 flex-1 list-none overflow-y-auto p-0">
            {notes.map((note) => (
              <li
                key={note.id}
                data-note-id={note.id}
                className="relative border-b border-slate-100"
              >
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
                    <span className="truncate">{noteTitle(note.content)}</span>
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
                {peers.length > 0 && (
                  <div
                    className="flex items-center -space-x-1.5"
                    aria-label="Other people in this note"
                  >
                    {peers.map((peer) => {
                      const label = caretLabel(peer.email, peer.agent);
                      return (
                        <span
                          key={presenceKey(peer.email, peer.agent)}
                          title={
                            peer.state === "editing"
                              ? `${label} is editing`
                              : `${label} is viewing`
                          }
                          className={`flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-[0.625rem] font-semibold ${
                            peer.agent
                              ? "bg-indigo-500 text-white"
                              : peer.state === "editing"
                                ? "bg-amber-500 text-white"
                                : "bg-slate-200 text-slate-700"
                          }`}
                        >
                          {peer.agent ? (
                            <Bot size={14} aria-hidden="true" />
                          ) : (
                            initialsFor(peer.email)
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}
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
                {selectedConflicted && (
                  <button
                    type="button"
                    className="flex h-9 flex-none items-center gap-1.5 rounded-lg bg-amber-600 px-3 text-[0.8125rem] font-medium text-white hover:bg-amber-700 active:bg-amber-700"
                    onClick={() => void keepMine()}
                    title="Save your version over the copy that changed elsewhere"
                  >
                    Keep mine
                  </button>
                )}
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
                revision={editorRevision}
                version={selectedNote?.version ?? 0}
                carets={selectedId ? (liveCarets[selectedId] ?? []) : []}
                onChange={handleChange}
                onCursor={(cursor) => {
                  if (selectedId) live.setCursor(selectedId, cursor);
                }}
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
