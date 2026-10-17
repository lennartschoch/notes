import { notePreview, noteTitle } from "shared";
import { lineEnd, noteView, pageStart, NOTE_PAGE_LINES } from "./text.js";
import type { Note } from "../types.js";

// Plain-text rendering of notes for tool and resource output. Notes are
// markdown documents, so they are handed back as readable text rather than as
// JSON; the metadata an agent needs to write safely (id and version) is always
// printed at the top.

export function stamp(iso: string): string {
  return iso.replace("T", " ").replace(/(\.\d{3})?Z$/, " UTC");
}

export function metaLine(note: Note): string {
  return `id: ${note.id} · ${note.visibility} · v${note.version} · updated ${stamp(note.updatedAt)}`;
}

export function fullNote(note: Note): string {
  return [
    `# ${noteTitle(note.content)}`,
    metaLine(note),
    `owner: ${note.owner || "unowned"}`,
    `created: ${stamp(note.createdAt)}`,
    "",
    "---",
    "",
    note.content.length > 0 ? note.content : "(empty note)",
  ].join("\n");
}

function header(note: Note): string {
  return [
    `# ${noteTitle(note.content)}`,
    metaLine(note),
    `owner: ${note.owner || "unowned"}`,
    `created: ${stamp(note.createdAt)}`,
  ].join("\n");
}

// A note paginated and numbered, with the reader's caret drawn where it stands -
// the shape that lets an agent get about a long note the way it gets about a
// file. `caret` is where the reader already stands, which decides what it sees
// next; the caret that comes back is where it stands once it has read this much,
// which is also what the people in the note are told.
export function readNote(
  note: Note,
  sight: { from?: number; lines?: number; caret?: number | null } = {},
): { text: string; caret: number } {
  const page = sight.lines ?? NOTE_PAGE_LINES;
  const framed = noteView(note.content, {
    from: sight.from ?? pageStart(note.content, sight.caret, page),
    lines: page,
  });
  const caret = lineEnd(note.content, framed.last);
  const shown = noteView(note.content, {
    from: framed.first,
    lines: framed.last - framed.first + 1,
    caret,
  });
  if (note.content.length === 0) {
    return { text: `${header(note)}\n\n---\n\n(empty note)`, caret: 0 };
  }
  const later = shown.total - shown.last;
  return {
    text: [
      header(note),
      "",
      "---",
      "",
      `lines ${shown.first}-${shown.last} of ${shown.total}`,
      "",
      shown.view,
      shown.first > 1
        ? `(lines 1-${shown.first - 1} are above: read with from: 1)`
        : "",
      later > 0
        ? `(${later} more line(s): read the note again with from: ${shown.last + 1})`
        : "",
    ]
      .join("\n")
      .trimEnd(),
    caret,
  };
}

export function listLines(notes: Note[], startIndex = 1): string {
  return notes
    .map((note, index) => {
      const preview = notePreview(note.content);
      return `${startIndex + index}. ${noteTitle(note.content)}\n   ${metaLine(note)}\n${preview.length > 0 ? `   ${preview}\n` : ""}`;
    })
    .join("\n");
}
