import { noteRemoved, scheduleNoteChange } from "./notifier.js";
import { noteChanged } from "./mcp/hub.js";
import {
  createNote as storeCreateNote,
  deleteNote as storeDeleteNote,
  setNoteVisibility as storeSetNoteVisibility,
  updateNote as storeUpdateNote,
  type UpdateResult,
} from "./store.js";
import { liveAgentActivity, liveNoteChanged, liveNoteGone } from "./ws.js";
import type { Actor, Note, Visibility } from "./types.js";

// The single write path for notes. The REST API and the MCP tools both mutate
// notes through these functions, so every surface gets the same side effects
// without having to remember them: push notifications for the other people a
// shared note is shared with, and staleness notifications for the MCP
// sessions that watch note:// resources. Reading stays on store.ts.

// Announce a saved note: push-notify the people who did not just edit it
// (only public notes have other people), tell the MCP sessions, and — for an
// agent — show it as live presence in the note's room. A human's own edit needs
// no synthetic presence: their browser tab already reports it over the socket.
function announceSaved(note: Note, actor: Actor): void {
  if (note.visibility === "public") scheduleNoteChange(note, actor);
  noteChanged(note.id);
  liveNoteChanged(note.id);
  liveAgentActivity(note, actor);
}

export async function createNote(
  content: string,
  actor: Actor,
  visibility?: Visibility,
): Promise<Note> {
  const note = await storeCreateNote(content, actor.email);
  const finalNote =
    visibility && visibility !== note.visibility
      ? ((await storeSetNoteVisibility(note.id, visibility, actor.email)) ??
        note)
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
  actor: Actor,
  baseContent?: string,
): Promise<UpdateResult> {
  const result = await storeUpdateNote(
    id,
    content,
    version,
    actor.email,
    baseContent,
  );
  if (result.status === "ok") announceSaved(result.note, actor);
  return result;
}

export async function setNoteVisibility(
  id: string,
  visibility: Visibility,
  actor: Actor,
): Promise<Note | undefined> {
  const note = await storeSetNoteVisibility(id, visibility, actor.email);
  if (note) {
    noteChanged(id);
    // Subscribers who just lost sight of the note receive a `gone` from the
    // hub's per-reader visibility filter.
    liveNoteChanged(id);
  }
  return note;
}

export async function deleteNote(id: string, actor: Actor): Promise<boolean> {
  const removed = await storeDeleteNote(id, actor.email);
  if (removed) {
    noteRemoved(id);
    noteChanged(id);
    liveNoteGone(id);
  }
  return removed;
}
