import { Placeholder } from "@tiptap/extensions";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import type { Node } from "@tiptap/pm/model";
import { useCallback, useEffect, useRef, useState } from "react";
import { CARET_ANCHOR_CHARS, type LiveCursor } from "shared";
import { EditorToolbar } from "./EditorToolbar";
import {
  DEFAULT_TODO_NAME,
  isTodoMarkdown,
  reconcileTodoMarkdown,
  startTodoMarkdown,
  todoDate,
} from "./todoList";

const extensions = [
  StarterKit.configure({ link: { openOnClick: false } }),
  Markdown,
  TaskList,
  TaskItem.configure({ nested: true }),
  Placeholder.configure({ placeholder: "Start typing…" }),
];

// How much text is used to find the caret again after a markdown rewrite
// (and, with it, by peers resolving a remote caret) — CARET_ANCHOR_CHARS
// from `shared`, which is also the wire limit the server enforces.

// Every character in the document with the position it sits at, so a caret can
// be relocated in a document that was rebuilt from markdown.
function textMap(doc: Node): { text: string; positions: number[] } {
  let text = "";
  const positions: number[] = [];
  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return;
    for (let offset = 0; offset < node.text.length; offset += 1) {
      text += node.text[offset];
      positions.push(position + offset);
    }
  });
  return { text, positions };
}

function caretAnchor(doc: Node, caret: number): string {
  const { text, positions } = textMap(doc);
  let end = positions.findIndex((position) => position >= caret);
  if (end === -1) end = positions.length;
  return text.slice(Math.max(0, end - CARET_ANCHOR_CHARS), end);
}

function positionOfText(doc: Node, anchor: string): number | null {
  if (anchor.trim() === "") return null;
  const { text, positions } = textMap(doc);
  const index = text.indexOf(anchor);
  if (index === -1) return null;
  return (
    positions[index + anchor.length] ?? positions[positions.length - 1] ?? null
  );
}

// A remote caret, measured into pixels for the overlay layer.
interface PeerCaret {
  email: string;
  left: number;
  top: number;
  height: number;
  color: string;
}

// A stable color per person, so two peers are never the same shade.
function caretColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i += 1) {
    hash = (hash * 31 + email.charCodeAt(i)) | 0;
  }
  return `hsl(${Math.abs(hash) % 360} 72% 45%)`;
}

// Which document position a peer's caret refers to: trusted outright when
// both copies still sit at the same version, otherwise relocated by the
// text it sits behind, and clamped to the document as a last resort.
function resolveCaretPosition(
  caret: LiveCursor,
  doc: Node,
  ourVersion: number,
): number | null {
  if (caret.position === null) return null;
  const size = doc.content.size;
  if (caret.version === ourVersion && caret.position <= size) {
    return caret.position;
  }
  const found = positionOfText(doc, caret.anchor);
  if (found !== null) return found;
  return Math.min(caret.position, size);
}

// Swap the whole document for rewritten markdown. That throws the caret away,
// so it is put back after the same text it was sitting behind, and the caller
// is told the note changed because the rewrite replaced a normal edit.
function replaceMarkdown(
  editor: Editor,
  markdown: string,
  onChange: (markdown: string) => void,
) {
  const anchor = caretAnchor(editor.state.doc, editor.state.selection.from);
  editor.commands.setContent(markdown, {
    contentType: "markdown",
    emitUpdate: false,
  });
  const position = positionOfText(editor.state.doc, anchor);
  if (position !== null) editor.commands.setTextSelection(position);
  onChange(markdown);
}

interface MarkdownEditorProps {
  noteId: string;
  initialMarkdown: string;
  revision: number;
  // The server version the note last settled at, reported with outgoing
  // carets so peers know whether their position can be trusted directly.
  version: number;
  // Where every other editor's caret currently is.
  carets: LiveCursor[];
  onChange: (markdown: string) => void;
  // This tab's caret moved (null when it is gone). Emitted throttled.
  onCursor: (
    cursor: { position: number; anchor: string; version: number } | null,
  ) => void;
}

function MarkdownEditor({
  noteId,
  initialMarkdown,
  revision,
  version,
  carets,
  onChange,
  onCursor,
}: MarkdownEditorProps) {
  const onChangeRef = useRef(onChange);
  const initialMarkdownRef = useRef(initialMarkdown);
  const onCursorRef = useRef(onCursor);
  const versionRef = useRef(version);

  useEffect(() => {
    onChangeRef.current = onChange;
    initialMarkdownRef.current = initialMarkdown;
    onCursorRef.current = onCursor;
    versionRef.current = version;
  });

  // The button is a one-shot: once the note is a to-do list, ticking and typing
  // keep it one, so the launch control is spent.
  const showTodoLaunch = !isTodoMarkdown(initialMarkdown);

  // Throttle caret chatter: keystrokes on a phone repeat fast, and a caret
  // older than ~100ms is stale anyway. The last broadcast is remembered so
  // an unmoved caret (a format button, say) stays silent.
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCursorSent = useRef("");

  const editor = useEditor({
    extensions,
    content: initialMarkdown,
    contentType: "markdown",
    onUpdate: ({ editor: current }) => {
      const markdown = current.getMarkdown();
      // Ticking an item files it under today, which rewrites the note.
      const filed = reconcileTodoMarkdown(markdown, todoDate());
      if (filed !== null) {
        replaceMarkdown(current, filed, onChangeRef.current);
        return;
      }
      onChangeRef.current(markdown);
    },
    editorProps: {
      attributes: {
        class:
          "note-content prose prose-slate max-w-none min-h-full px-4 pt-3 pb-[calc(1.5rem+env(safe-area-inset-bottom))]",
        "aria-label": "Note content",
      },
    },
  });

  // Every edit and caret move is a transaction, so the editor's own events
  // drive reporting — including the first report when a note is opened.
  useEffect(() => {
    if (!editor) return;
    const broadcast = () => {
      const position = editor.state.selection.from;
      const anchor = caretAnchor(editor.state.doc, position);
      const key = `${position}\u0000${versionRef.current}`;
      if (key === lastCursorSent.current) return;
      lastCursorSent.current = key;
      onCursorRef.current({ position, anchor, version: versionRef.current });
    };
    const schedule = () => {
      if (cursorTimer.current) return;
      cursorTimer.current = setTimeout(() => {
        cursorTimer.current = null;
        broadcast();
      }, 100);
    };
    editor.on("transaction", schedule);
    schedule(); // report the caret when the note is first opened
    return () => {
      editor.off("transaction", schedule);
      if (cursorTimer.current) {
        clearTimeout(cursorTimer.current);
        // Forget the spent handle, or the next subscription's schedule()
        // would believe a timer is still pending and never broadcast again.
        cursorTimer.current = null;
      }
    };
  }, [editor, noteId]);

  const lastNoteId = useRef(noteId);
  useEffect(() => {
    if (!editor || lastNoteId.current === noteId) return;
    lastNoteId.current = noteId;
    editor.commands.setContent(initialMarkdownRef.current, {
      contentType: "markdown",
      emitUpdate: false,
    });
  }, [editor, noteId]);

  const lastRevision = useRef(revision);
  useEffect(() => {
    if (!editor || lastRevision.current === revision) return;
    lastRevision.current = revision;
    if (editor.getMarkdown() === initialMarkdownRef.current) return;
    editor.commands.setContent(initialMarkdownRef.current, {
      contentType: "markdown",
      emitUpdate: false,
    });
  }, [editor, revision]);

  function launchTodoList() {
    if (!editor) return;
    // The name is asked for once, up front, because the title is the only place
    // this app has to keep one.
    const name = window.prompt("Name this to-do list", DEFAULT_TODO_NAME);
    if (name === null) return;
    const markdown = startTodoMarkdown(editor.getMarkdown(), name);
    editor.commands.setContent(markdown, {
      contentType: "markdown",
      emitUpdate: false,
    });
    editor.commands.focus("end");
    onChangeRef.current(markdown);
  }

  // ---- Remote carets: resolve, measure, draw -------------------------
  // A caret is a document position, so each redraw recomputes pixel offsets
  // against the live layout — which also makes them immune to scrolling,
  // because the overlay lives inside the scrolled content.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [peerCarets, setPeerCarets] = useState<PeerCaret[]>([]);
  const caretsRef = useRef(carets);
  useEffect(() => {
    caretsRef.current = carets;
  });

  const redraw = useCallback(() => {
    const view = editor?.view;
    const wrap = wrapRef.current;
    if (!view || !wrap) {
      setPeerCarets([]);
      return;
    }
    const wrapRect = wrap.getBoundingClientRect();
    const next: PeerCaret[] = [];
    for (const caret of caretsRef.current) {
      const pos = resolveCaretPosition(
        caret,
        view.state.doc,
        versionRef.current,
      );
      if (pos === null) continue;
      let coords: ReturnType<Editor["view"]["coordsAtPos"]>;
      try {
        coords = view.coordsAtPos(pos);
      } catch {
        // The position fell outside the document mid-rewrite; drop it.
        continue;
      }
      next.push({
        email: caret.email,
        left: coords.left - wrapRect.left,
        top: coords.top - wrapRect.top,
        height: Math.max(coords.bottom - coords.top, 16),
        color: caretColor(caret.email),
      });
    }
    setPeerCarets(next);
  }, [editor]);

  useEffect(() => {
    redraw();
  }, [redraw, carets, revision, noteId]);

  // Content rewrites (local edits, remote snapshots) move everything the
  // carets were measured against, so redraw once per frame after any change.
  useEffect(() => {
    if (!editor) return;
    let frame: number | null = null;
    const onTransaction = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        redraw();
      });
    };
    editor.on("transaction", onTransaction);
    window.addEventListener("resize", onTransaction);
    window.visualViewport?.addEventListener("resize", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
      window.removeEventListener("resize", onTransaction);
      window.visualViewport?.removeEventListener("resize", onTransaction);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [editor, redraw]);

  if (!editor) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none">
        <EditorToolbar
          editor={editor}
          showTodoLaunch={showTodoLaunch}
          onStartTodoList={launchTodoList}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto [-webkit-overflow-scrolling:touch]">
        <div ref={wrapRef} className="relative">
          <EditorContent editor={editor} />
          <div
            className="pointer-events-none absolute inset-0"
            aria-hidden="true"
          >
            {peerCarets.map((caret) => (
              <span
                key={caret.email}
                className="remote-caret"
                style={{
                  transform: `translate(${caret.left}px, ${caret.top}px)`,
                  height: `${caret.height}px`,
                  backgroundColor: caret.color,
                }}
                title={`${caret.email} is here`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default MarkdownEditor;
