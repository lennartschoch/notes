// The live-editing protocol spoken on the /ws WebSocket between the server
// and the web client. Kept in `shared` so both ends agree on the shape of
// every frame: the client subscribes to notes it has open and reports its
// presence; the server pushes note snapshots the moment they change and the
// list of who else is in each note.

export type PresenceState = "viewing" | "editing";

// A note as the live channel carries it — the same fields the REST API
// returns, restated here so `shared` stays free of either app's Note type.
export interface LiveNoteSnapshot {
  id: string;
  content: string;
  owner: string;
  visibility: "private" | "public";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LiveEditor {
  email: string;
  state: PresenceState;
}

// How much text travels with a caret so a receiver can find it again when
// the two copies of the note have drifted apart.
export const CARET_ANCHOR_CHARS = 24;

// Where one editor's caret sits. `position` counts characters in the
// sender's copy of the note as `version`; receivers whose copy differs
// relocate the caret by looking for `anchor` (the text just before it).
// A null position is a deliberate clearing of that peer's caret.
export interface LiveCursor {
  email: string;
  position: number | null;
  anchor: string;
  version: number;
}

export type LiveClientMessage =
  | { type: "subscribe"; noteId: string }
  | { type: "unsubscribe"; noteId: string }
  | { type: "presence"; noteId: string; state: PresenceState }
  // Where my caret just moved in this note (or that it is gone).
  | {
      type: "cursor";
      noteId: string;
      position: number | null;
      anchor: string;
      version: number;
    };

export type LiveServerMessage =
  // The note changed (content, visibility, or both). It is only sent to
  // connections allowed to see it.
  | { type: "note"; note: LiveNoteSnapshot }
  // The note was deleted, or became invisible to this reader.
  | { type: "gone"; noteId: string }
  // Who currently has this note open.
  | { type: "presence"; noteId: string; editors: LiveEditor[] }
  // A peer's caret moved in this note.
  | { type: "cursor"; noteId: string; cursor: LiveCursor };
