import { anchorFromText, type PresenceState } from "shared";
import { liveAgentCursor } from "../ws.js";
import { relocateCaret } from "./text.js";
import type { Actor, Note } from "../types.js";

// What one MCP connection remembers about where it stands in the notes it has
// been working on. An agent has no socket to hold a cursor on, so this is the
// server's memory of it: reading a note puts the agent there, editing moves it,
// and it stops being mentioned to the room once the agent has been quiet for a
// while (see ws.ts). Nothing here is announced under another identity: the caret
// is always this connection's own, and labelled as an agent's by the app.
export interface AgentCarets {
  // Where this agent's caret is in a note, followed along if the note moved
  // under it. Null when it has never read or edited this one.
  locate(note: Note): number | null;
  // Say where the agent just was: whoever is watching the note sees the caret
  // move and the chip say whether it is typing or reading.
  show(note: Note, caret: number, state: PresenceState): void;
  // Stop remembering a note, because it is gone.
  forget(noteId: string): void;
}

export function createCarets(actor: Actor): AgentCarets {
  // Offsets into the markdown this connection last saw, plus the words the caret
  // sat behind so they can be found again after someone else typed.
  const remembered = new Map<string, { position: number; anchor: string }>();

  function remember(note: Note, caret: number) {
    const clamped = Math.max(0, Math.min(caret, note.content.length));
    const cursor = {
      position: clamped,
      anchor: anchorFromText(note.content, clamped),
    };
    remembered.set(note.id, cursor);
    return cursor;
  }

  return {
    locate: (note) => {
      const at = remembered.get(note.id);
      if (!at) return null;
      // Somebody else may have typed since: the words the caret sat behind
      // decide where it goes, the same way they do for a peer's in the editor.
      const caret = relocateCaret(note.content, at);
      remembered.set(note.id, {
        position: caret,
        anchor: anchorFromText(note.content, caret),
      });
      return caret;
    },
    show: (note, caret, state) => {
      const cursor = remember(note, caret);
      liveAgentCursor({
        noteId: note.id,
        actor,
        sessionId: actor.sessionId,
        position: cursor.position,
        anchor: cursor.anchor,
        version: note.version,
        state,
      });
    },
    forget: (noteId) => {
      remembered.delete(noteId);
    },
  };
}
