import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Globe, Lock } from "lucide-react";
import { api, type Note } from "./api";

const MarkdownEditor = lazy(() => import("./components/MarkdownEditor"));

const SAVE_DELAY_MS = 800;

type SaveStatus = "idle" | "saving" | "saved" | "error";
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

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ id: string; content: string } | null>(null);

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
        setNotes(list);
        const first = list[0];
        if (first) {
          setSelectedId(first.id);
          setDraft(first.content);
        }
      })
      .catch(() => setStatus("error"))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const entry = pending.current;
    if (!entry) return;
    pending.current = null;
    setStatus("saving");
    try {
      const updated = await api.update(entry.id, entry.content);
      setNotes((prev) =>
        prev.map((note) => (note.id === updated.id ? updated : note)),
      );
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }, []);

  const scheduleSave = useCallback(
    (id: string, content: string) => {
      pending.current = { id, content };
      setStatus("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void flush();
      }, SAVE_DELAY_MS);
    },
    [flush],
  );

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
    if (id !== selectedId) {
      await flush();
      const note = notes.find((n) => n.id === id);
      if (!note) return;
      setSelectedId(id);
      setDraft(note.content);
      setStatus("idle");
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
      setStatus("idle");
      setPane("editor");
    } catch {
      setStatus("error");
    }
  }

  async function removeNote(id: string) {
    if (!window.confirm("Delete this note?")) return;
    if (pending.current?.id === id) {
      pending.current = null;
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
        setStatus("idle");
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
                    status === "error" ? "text-red-600" : "text-slate-500"
                  }`}
                  aria-live="polite"
                >
                  {status === "saving" && "Saving…"}
                  {status === "saved" && "Saved"}
                  {status === "error" && "Save failed"}
                </span>
              </div>
            </header>
            <Suspense
              fallback={<p className="p-4 text-slate-500">Loading editor…</p>}
            >
              <MarkdownEditor
                noteId={selectedId}
                initialMarkdown={draft}
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
