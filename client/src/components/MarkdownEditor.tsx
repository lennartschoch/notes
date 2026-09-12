import { Placeholder } from "@tiptap/extensions";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { useEffect, useRef } from "react";
import { EditorToolbar } from "./EditorToolbar";

const extensions = [
  StarterKit.configure({ link: { openOnClick: false } }),
  Markdown,
  TaskList,
  TaskItem.configure({ nested: true }),
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

  if (!editor) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EditorToolbar editor={editor} />
      <div className="min-h-0 flex-1 overflow-y-auto [-webkit-overflow-scrolling:touch]">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

export default MarkdownEditor;
