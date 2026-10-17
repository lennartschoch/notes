import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  CARET_ANCHOR_CHARS,
  presenceKey,
  type LiveClientMessage,
  type LiveCursor,
  type LiveEditor,
  type LiveNoteSnapshot,
  type LiveServerMessage,
  type PresenceState,
} from "shared";
import { identityFromHandshake } from "./auth.js";
import { canView, peekNote } from "./store.js";
import type { Actor } from "./types.js";

// The live channel: one WebSocket per open tab. A connection subscribes to
// the notes it has open; every note write (REST, MCP, or another tab) pushes
// the fresh snapshot to the subscribers that may see it, so clients converge
// in milliseconds instead of waiting for their next poll. Connections also
// report a presence state per subscribed note ("viewing" or "editing"), and
// the hub mirrors the room's roster back to everyone in it.
//
// All of it is best-effort: a closed or slow socket never blocks a write.

interface Client {
  socket: WebSocket;
  email: string;
  notes: Set<string>;
  // Each note where this client has published a caret, kept so late joiners
  // see it too, and so leaving can clear it.
  carets: Map<string, Omit<LiveCursor, "email">>;
  alive: boolean;
}

// A presence entry for an agent acting over HTTP (MCP), which has no socket of
// its own. When such an agent reads or edits a note we surface it to the people
// in the room as "<account>'s agent", distinct from the account's own tabs: a
// caret where the agent says it is, and a chip saying whether it is looking or
// typing. Agents announce where they are and leave when they are done; the
// timeouts below are the safety net for one that vanishes mid-sentence.
interface AgentPresence {
  actor: Actor;
  // Which MCP session owns this presence, so closing that connection takes its
  // caret out of every room with it instead of waiting for the timeout.
  sessionId: string;
  caret: Omit<LiveCursor, "email" | "agent">;
  state: PresenceState;
  // What this presence settles back to when the typing burst ends: "viewing"
  // for an agent sitting in the note, null for one that only made an edit.
  settlesTo: PresenceState | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const clients = new Set<Client>();
const rooms = new Map<string, Set<Client>>();
const presence = new Map<string, Map<Client, PresenceState>>();
// noteId -> presenceKey(email, true) -> ephemeral agent presence. One caret per
// agent identity per note: two sessions of the same account's agent share the
// peer the room sees, the way two tabs of one person share a chip.
const agentPresence = new Map<string, Map<string, AgentPresence>>();

// How long each kind of agent presence survives without another call from it. A
// typing burst that stopped is over; a reader may only be thinking. Together they
// are how an agent leaves a note: nobody has to tell it to go.
const AGENT_IDLE_MS: Record<PresenceState, number> = {
  editing: 12_000,
  viewing: 180_000,
};

function send(client: Client, message: LiveServerMessage): void {
  if (client.socket.readyState !== WebSocket.OPEN) return;
  try {
    client.socket.send(JSON.stringify(message));
  } catch {
    // A socket that dies mid-send is reaped by its close event.
  }
}

function snapshot(note: LiveNoteSnapshot): LiveNoteSnapshot {
  return {
    id: note.id,
    content: note.content,
    owner: note.owner,
    visibility: note.visibility,
    version: note.version,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

function presenceRoster(noteId: string): LiveEditor[] {
  const roster: LiveEditor[] = [];
  const inRoom = presence.get(noteId);
  if (inRoom) {
    for (const [client, state] of inRoom) {
      roster.push({ email: client.email, state });
    }
  }
  for (const agent of agentPresence.get(noteId)?.values() ?? []) {
    roster.push({ email: agent.actor.email, agent: true, state: agent.state });
  }
  return roster;
}

function broadcastPresence(noteId: string): void {
  const roster = presenceRoster(noteId);
  for (const client of rooms.get(noteId) ?? []) {
    send(client, { type: "presence", noteId, editors: roster });
  }
}

function setPresence(client: Client, noteId: string, state: PresenceState) {
  if (!client.notes.has(noteId)) return;
  let inRoom = presence.get(noteId);
  if (!inRoom) {
    inRoom = new Map();
    presence.set(noteId, inRoom);
  }
  if (inRoom.get(client) === state) return;
  inRoom.set(client, state);
  broadcastPresence(noteId);
}

function forget(client: Client, noteId: string): void {
  client.notes.delete(noteId);
  const inRoom = presence.get(noteId);
  if (inRoom?.delete(client)) broadcastPresence(noteId);
  rooms.get(noteId)?.delete(client);
  // A peer that vanishes mid-edit must not leave a ghost caret behind.
  if (client.carets.delete(noteId)) {
    broadcastCursor(noteId, null, client.email, {
      position: null,
      anchor: "",
      version: 0,
    });
  }
}

// Carets are ephemeral: relayed to the rest of the room, never persisted,
// versioned, or replayed across reconnects — but held long enough to hand to
// the next person who opens the note. The sender is skipped by identity, not
// by email, so a second tab of the same person still sees this tab's caret.
function broadcastCursor(
  noteId: string,
  sender: Client | null,
  email: string,
  cursor: Omit<LiveCursor, "email">,
): void {
  for (const peer of rooms.get(noteId) ?? []) {
    if (peer === sender) continue;
    send(peer, { type: "cursor", noteId, cursor: { email, ...cursor } });
  }
}

function handleCursor(
  client: Client,
  message: Extract<LiveClientMessage, { type: "cursor" }>,
): void {
  if (!client.notes.has(message.noteId)) return;
  const position =
    typeof message.position === "number" &&
    Number.isInteger(message.position) &&
    message.position >= 0
      ? message.position
      : null;
  const cursor: Omit<LiveCursor, "email"> =
    position === null
      ? { position: null, anchor: "", version: 0 }
      : {
          position,
          anchor: String(message.anchor ?? "").slice(0, CARET_ANCHOR_CHARS),
          version: Number.isFinite(message.version)
            ? Math.max(0, Math.trunc(message.version))
            : 0,
        };
  if (position === null) client.carets.delete(message.noteId);
  else client.carets.set(message.noteId, cursor);
  broadcastCursor(message.noteId, client, client.email, cursor);
}

// Push the note's current state to every subscriber that may see it. Called
// after any write: content save, visibility change, or the note vanishing.
export function liveNoteChanged(noteId: string): void {
  const room = rooms.get(noteId);
  if (!room || room.size === 0) return;
  const note = peekNote(noteId);
  for (const client of room) {
    if (note && canView(note, client.email)) {
      send(client, { type: "note", note: snapshot(note) });
    } else {
      // Deleted, or made private by someone else: nothing left to show.
      send(client, { type: "gone", noteId });
    }
  }
}

export function liveNoteGone(noteId: string): void {
  liveNoteChanged(noteId);
  presence.delete(noteId);
  clearAllAgentPresence(noteId);
}

export interface AgentCursorOptions {
  noteId: string;
  actor: Actor;
  sessionId?: string;
  // Where the caret sits, in the agent's coordinates: a character offset in the
  // markdown plus the text it sits behind. Receivers relocate by the anchor, so
  // the offset is only ever a fallback (see LiveCursor).
  position: number | null;
  anchor: string;
  version: number;
  // "editing" while the agent is typing, "viewing" when it is reading along.
  state?: PresenceState;
}

function sameCaret(
  a: Omit<LiveCursor, "email" | "agent">,
  b: Omit<LiveCursor, "email" | "agent">,
): boolean {
  return (
    a.position === b.position &&
    a.anchor === b.anchor &&
    a.version === b.version
  );
}

// Announce where an agent is in a note: everyone else in the room sees a caret
// and a chip attributed to that agent, and can watch it move as the agent works.
export function liveAgentCursor(options: AgentCursorOptions): void {
  const { actor, noteId } = options;
  if (!actor.agent) return;
  const key = presenceKey(actor.email, true);
  if (options.position === null) {
    clearAgentPresence(noteId, key);
    return;
  }
  const caret: Omit<LiveCursor, "email" | "agent"> = {
    position: options.position,
    anchor: options.anchor,
    version: options.version,
  };
  let agents = agentPresence.get(noteId);
  if (!agents) {
    agents = new Map();
    agentPresence.set(noteId, agents);
  }
  const state: PresenceState = options.state ?? "editing";
  const existing = agents.get(key);
  // A caret that has not moved and a chip that has not changed are not news:
  // resending them would make every peer's overlay blink for nothing. The timer
  // still restarts, because the agent being quiet is not the agent being gone.
  if (
    existing &&
    existing.state === state &&
    sameCaret(existing.caret, caret)
  ) {
    setAgentTimer(existing, noteId, key);
    return;
  }
  const entry: AgentPresence = existing ?? {
    actor,
    sessionId: "",
    caret,
    state,
    settlesTo: null,
    timer: null,
  };
  entry.actor = actor;
  entry.sessionId = options.sessionId ?? "";
  entry.caret = caret;
  entry.state = state;
  // An agent that typed is still around afterwards, reading; one that has only
  // been reading has nothing to fall back to.
  entry.settlesTo = state === "editing" ? "viewing" : null;
  agents.set(key, entry);
  setAgentTimer(entry, noteId, key);
  broadcastPresence(noteId);
  broadcastCursor(noteId, null, actor.email, { agent: true, ...caret });
}

function setAgentTimer(
  entry: AgentPresence,
  noteId: string,
  key: string,
): void {
  if (entry.timer) clearTimeout(entry.timer);
  // Presence sweeps must not keep a closing process alive.
  entry.timer = setTimeout(
    () => decayAgentPresence(noteId, key),
    AGENT_IDLE_MS[entry.state],
  );
  entry.timer.unref?.();
}

// Agent presence fades the way a person's would: the typing stops, the chip goes
// from "is editing" to "is viewing", and only later does the caret leave.
function decayAgentPresence(noteId: string, key: string): void {
  const entry = agentPresence.get(noteId)?.get(key);
  if (!entry) return;
  const settlesTo = entry.settlesTo;
  if (!settlesTo || settlesTo === entry.state) {
    clearAgentPresence(noteId, key);
    return;
  }
  entry.state = settlesTo;
  entry.settlesTo = null;
  setAgentTimer(entry, noteId, key);
  broadcastPresence(noteId);
}

// An MCP session that closes takes its agent's presence with it: nobody should
// keep watching a caret for an agent that has already gone home.
export function liveAgentLeaveSession(sessionId: string): void {
  if (sessionId.length === 0) return;
  for (const [noteId, agents] of agentPresence) {
    for (const [key, entry] of agents) {
      if (entry.sessionId === sessionId) clearAgentPresence(noteId, key);
    }
  }
}

function clearAgentPresence(noteId: string, key: string): void {
  const agents = agentPresence.get(noteId);
  const entry = agents?.get(key);
  if (!agents || !entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  agents.delete(key);
  if (agents.size === 0) agentPresence.delete(noteId);
  broadcastPresence(noteId);
  broadcastCursor(noteId, null, entry.actor.email, {
    agent: true,
    position: null,
    anchor: "",
    version: 0,
  });
}

function clearAllAgentPresence(noteId: string): void {
  const agents = agentPresence.get(noteId);
  if (!agents) return;
  for (const entry of agents.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  agentPresence.delete(noteId);
}

function attach(client: Client): void {
  client.socket.on("pong", () => {
    client.alive = true;
  });
  client.socket.on("message", (raw: Buffer) => {
    let message: LiveClientMessage;
    try {
      message = JSON.parse(String(raw)) as LiveClientMessage;
    } catch {
      return;
    }
    if (message.type === "subscribe") {
      const note = peekNote(message.noteId);
      if (!note || !canView(note, client.email)) {
        // Not ours to watch; say so instead of leaving the client waiting.
        send(client, { type: "gone", noteId: message.noteId });
        return;
      }
      client.notes.add(message.noteId);
      let room = rooms.get(message.noteId);
      if (!room) {
        room = new Set();
        rooms.set(message.noteId, room);
      }
      room.add(client);
      setPresence(client, message.noteId, "viewing");
      // Carets already in the room belong to the joiner's eyes too; the
      // live relay only ever reaches clients present at the time.
      for (const peer of room) {
        const caret = peer.carets.get(message.noteId);
        if (caret) {
          send(client, {
            type: "cursor",
            noteId: message.noteId,
            cursor: { email: peer.email, ...caret },
          });
        }
      }
      // A live agent's caret belongs to the replay too: it is not a socket.
      for (const agent of agentPresence.get(message.noteId)?.values() ?? []) {
        send(client, {
          type: "cursor",
          noteId: message.noteId,
          cursor: { email: agent.actor.email, agent: true, ...agent.caret },
        });
      }
    } else if (message.type === "unsubscribe") {
      forget(client, message.noteId);
    } else if (message.type === "presence") {
      setPresence(client, message.noteId, message.state);
    } else if (message.type === "cursor") {
      handleCursor(client, message);
    }
  });
  client.socket.on("close", () => {
    clients.delete(client);
    // forget() only removes the note it is given, so iterating the live set
    // while it sheds its current entry is safe.
    for (const noteId of client.notes) forget(client, noteId);
  });
  client.socket.on("error", () => {
    client.socket.terminate();
  });
}

export function initLive(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let path = "";
    let queryEmail: string | null = null;
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      path = url.pathname;
      queryEmail = url.searchParams.get("email");
    } catch {
      // Malformed request URL: fall through to the rejection below.
    }
    if (path !== "/ws") return; // somebody else's upgrade
    void identityFromHandshake({ headers: req.headers, queryEmail }).then(
      (identity) => {
        if (!identity) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const client: Client = {
            socket: ws,
            email: identity.email,
            notes: new Set(),
            carets: new Map(),
            alive: true,
          };
          clients.add(client);
          attach(client);
        });
      },
    );
  });

  // Drop sockets that stopped answering pings, so dead tabs leave their
  // presence behind instead of haunting the roster.
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, 30_000);
  heartbeat.unref();
}
