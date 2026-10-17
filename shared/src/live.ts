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
  // True when an AI agent is driving this identity rather than the person
  // themselves (see MCP.md). Absent/false for a real user. A boolean rather
  // than a name on purpose: the account model allows at most one agent per
  // account, and a name the agent chose for itself would be an impersonation
  // vector. The UI renders the label ("<email>'s agent"), never the agent.
  agent?: boolean;
  state: PresenceState;
}

// A peer is identified by the account *and* whether an agent is driving it: a
// person and an agent acting as that same person are distinct peers, so both the
// presence roster and the caret overlay key on this composite, not the bare
// email. `\u0000` cannot appear in an email.
export function presenceKey(email: string, agent?: boolean): string {
  return agent ? `${email}\u0000agent` : email;
}

// How much text travels with a caret so a receiver can find it again when
// the two copies of the note have drifted apart.
export const CARET_ANCHOR_CHARS = 24;

// The last line of a piece of text, at most CARET_ANCHOR_CHARS of it — an
// anchor is text the editor can find, and on screen block boundaries are not
// characters.
function lineTail(text: string): string {
  const clipped = text.slice(Math.max(0, text.length - CARET_ANCHOR_CHARS));
  return clipped.slice(clipped.lastIndexOf("\n") + 1);
}

// The text a caret sits behind, taken from a plain-text copy of the note — the
// shape an agent has: it holds markdown, not an editor document, so it has no
// positions to speak of. Receivers relocate an agent's caret with this text
// (see LiveCursor), so it must be findable: never reaching across a line break,
// and never merely whitespace. A caret at the start of a line sits at the end of
// the previous one, so it anchors there.
export function anchorFromText(text: string, caret: number): string {
  const at = Math.max(0, Math.min(Math.trunc(caret), text.length));
  const current = lineTail(text.slice(0, at));
  if (current.trim().length > 0) return current;
  return lineTail(text.slice(0, at - current.length).replace(/\s+$/, ""));
}

// Where one editor's caret sits. `position` counts characters in the
// sender's copy of the note as `version`; receivers whose copy differs
// relocate the caret by looking for `anchor` (the text just before it).
// A null position is a deliberate clearing of that peer's caret.
//
// Positions are only comparable between peers that measure the same way, and an
// agent cannot: it counts characters of markdown, a tab counts editor positions.
// So `agent` carets always relocate by their anchor instead of trusting a number
// from another coordinate system (see resolveCaretPosition).
export interface LiveCursor {
  email: string;
  // Set when an agent is driving this caret (see LiveEditor.agent).
  agent?: boolean;
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
