import { Placeholder } from "@tiptap/extensions";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import type { Node } from "@tiptap/pm/model";
import { useEffect, useRef, useState } from "react";
import { api, type Sticker as StickerData } from "../api";
import { EditorToolbar } from "./EditorToolbar";
import { Sticker } from "./sticker";
import {
  isTodoMarkdown,
  reconcileTodoMarkdown,
  startTodoMarkdown,
  todoDate,
} from "./todoList";
import { StickerPicker } from "./StickerPicker";
import { StickerUploadDialog } from "./StickerUploadDialog";

const extensions = [
  StarterKit.configure({ link: { openOnClick: false } }),
  Markdown,
  TaskList,
  TaskItem.configure({ nested: true }),
  Sticker,
  Placeholder.configure({ placeholder: "Start typing…" }),
];

// How much text is used to find the caret again after a markdown rewrite.
const CARET_ANCHOR_CHARS = 24;

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
  userEmail: string | null;
  revision: number;
  onChange: (markdown: string) => void;
}

function MarkdownEditor({
  noteId,
  initialMarkdown,
  userEmail,
  revision,
  onChange,
}: MarkdownEditorProps) {
  const onChangeRef = useRef(onChange);
  const initialMarkdownRef = useRef(initialMarkdown);

  const [stickers, setStickers] = useState<StickerData[]>([]);
  const [stickersLoading, setStickersLoading] = useState(true);
  const [stickersError, setStickersError] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listStickers()
      .then((list) => {
        if (!cancelled) setStickers(list);
      })
      .catch(() => {
        if (!cancelled) setStickersError(true);
      })
      .finally(() => {
        if (!cancelled) setStickersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    onChangeRef.current = onChange;
    initialMarkdownRef.current = initialMarkdown;
  });

  // The button is a one-shot: once the note is a to-do list, ticking and typing
  // keep it one, so the launch control is spent.
  const showTodoLaunch = !isTodoMarkdown(initialMarkdown);

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
    const markdown = startTodoMarkdown(editor.getMarkdown(), todoDate());
    editor.commands.setContent(markdown, {
      contentType: "markdown",
      emitUpdate: false,
    });
    editor.commands.focus("end");
    onChangeRef.current(markdown);
  }

  function insertSticker(sticker: StickerData) {
    editor
      ?.chain()
      .focus()
      .insertSticker({ id: sticker.id, name: sticker.name })
      .run();
    setPickerOpen(false);
  }

  function handleCreated(sticker: StickerData) {
    setStickers((prev) => [sticker, ...prev]);
    setUploadOpen(false);
    insertSticker(sticker);
  }

  async function handleDelete(sticker: StickerData) {
    if (
      !window.confirm(
        `Delete "${sticker.name}"? Notes using it will no longer show the image.`,
      )
    ) {
      return;
    }
    try {
      await api.removeSticker(sticker.id);
      setStickers((prev) => prev.filter((item) => item.id !== sticker.id));
    } catch {
      window.alert("Could not delete the sticker.");
    }
  }

  if (!editor) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex-none">
        <EditorToolbar
          editor={editor}
          stickerPickerOpen={pickerOpen}
          onToggleStickerPicker={() => setPickerOpen((open) => !open)}
          showTodoLaunch={showTodoLaunch}
          onStartTodoList={launchTodoList}
        />
        {pickerOpen && (
          <StickerPicker
            stickers={stickers}
            loading={stickersLoading}
            error={stickersError}
            canDelete={(sticker) =>
              sticker.owner === "" || sticker.owner === userEmail
            }
            onPick={insertSticker}
            onAdd={() => {
              setPickerOpen(false);
              setUploadOpen(true);
            }}
            onDelete={(sticker) => void handleDelete(sticker)}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto [-webkit-overflow-scrolling:touch]">
        <EditorContent editor={editor} />
      </div>
      {uploadOpen && (
        <StickerUploadDialog
          onClose={() => setUploadOpen(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}

export default MarkdownEditor;
