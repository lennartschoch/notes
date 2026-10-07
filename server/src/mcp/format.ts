import { notePreview, noteTitle } from "shared";
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

export function listLines(notes: Note[], startIndex = 1): string {
  return notes
    .map((note, index) => {
      const preview = notePreview(note.content);
      return `${startIndex + index}. ${noteTitle(note.content)}\n   ${metaLine(note)}\n${preview.length > 0 ? `   ${preview}\n` : ""}`;
    })
    .join("\n");
}
