import { noteRemoved, scheduleNoteChange } from "./notifier.js";
import { noteChanged } from "./mcp/hub.js";
import {
  createNote as storeCreateNote,
  deleteNote as storeDeleteNote,
  setNoteVisibility as storeSetNoteVisibility,
  updateNote as storeUpdateNote,
  type UpdateResult,
} from "./store.js";
import type { Note, Visibility } from "./types.js";

// The single write path for notes. The REST API and the MCP tools both mutate
// notes through these functions, so every surface gets the same side effects
// without having to remember them: push notifications for the other people a
// shared note is shared with, and staleness notifications for the MCP
// sessions that watch note:// resources. Reading stays on store.ts.

// Announce a saved note: push-notify the people who did not just edit it
// (only public notes have other people), and tell the MCP sessions.
function announceSaved(note: Note, editorEmail: string): void {
  if (note.visibility === "public") scheduleNoteChange(note, editorEmail);
  noteChanged(note.id);
}

export async function createNote(
  content: string,
  owner: string,
  visibility?: Visibility,
): Promise<Note> {
  const note = await storeCreateNote(content, owner);
  const finalNote =
    visibility && visibility !== note.visibility
      ? ((await storeSetNoteVisibility(note.id, visibility, owner)) ?? note)
      : note;
  // Creating notifies nobody by push (the editors list is empty), but the
  // shared MCP index gained an entry.
  noteChanged(finalNote.id);
  return finalNote;
}

export async function updateNote(
  id: string,
  content: string,
  version: number,
  email: string,
): Promise<UpdateResult> {
  const result = await storeUpdateNote(id, content, version, email);
  if (result.status === "ok") announceSaved(result.note, email);
  return result;
}

export async function setNoteVisibility(
  id: string,
  visibility: Visibility,
  email: string,
): Promise<Note | undefined> {
  const note = await storeSetNoteVisibility(id, visibility, email);
  if (note) noteChanged(id);
  return note;
}

export async function deleteNote(id: string, email: string): Promise<boolean> {
  const removed = await storeDeleteNote(id, email);
  if (removed) {
    noteRemoved(id);
    noteChanged(id);
  }
  return removed;
}
