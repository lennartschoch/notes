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

export type LiveClientMessage =
  | { type: "subscribe"; noteId: string }
  | { type: "unsubscribe"; noteId: string }
  | { type: "presence"; noteId: string; state: PresenceState };

export type LiveServerMessage =
  // The note changed (content, visibility, or both). It is only sent to
  // connections allowed to see it.
  | { type: "note"; note: LiveNoteSnapshot }
  // The note was deleted, or became invisible to this reader.
  | { type: "gone"; noteId: string }
  // Who currently has this note open.
  | { type: "presence"; noteId: string; editors: LiveEditor[] };
