import { Placeholder } from "@tiptap/extensions";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { api, type Sticker as StickerData } from "../api";
import { EditorToolbar } from "./EditorToolbar";
import { Sticker } from "./sticker";
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

interface MarkdownEditorProps {
  noteId: string;
  initialMarkdown: string;
  onChange: (markdown: string) => void;
}

function MarkdownEditor({
  noteId,
  initialMarkdown,
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

  const editor = useEditor({
    extensions,
    content: initialMarkdown,
    contentType: "markdown",
    onUpdate: ({ editor: current }) => {
      onChangeRef.current(current.getMarkdown());
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

  if (!editor) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex-none">
        <EditorToolbar
          editor={editor}
          stickerPickerOpen={pickerOpen}
          onToggleStickerPicker={() => setPickerOpen((open) => !open)}
        />
        {pickerOpen && (
          <StickerPicker
            stickers={stickers}
            loading={stickersLoading}
            error={stickersError}
            onPick={insertSticker}
            onAdd={() => {
              setPickerOpen(false);
              setUploadOpen(true);
            }}
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
