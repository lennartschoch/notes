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
// its own. When such an agent edits a note we surface it to the people in the
// room as "<account>'s agent", distinct from the account's own tabs, and let it
// fade once the agent stops (agents have no idle/typing signal to key on).
interface AgentPresence {
  actor: Actor;
  caret: Omit<LiveCursor, "email" | "agent">;
  timer: ReturnType<typeof setTimeout> | null;
}

const clients = new Set<Client>();
const rooms = new Map<string, Set<Client>>();
const presence = new Map<string, Map<Client, PresenceState>>();
// noteId -> presenceKey(email, true) -> ephemeral agent presence.
const agentPresence = new Map<string, Map<string, AgentPresence>>();
// How long an agent stays visible in a room after its last write.
const AGENT_PRESENCE_MS = 12_000;

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
    roster.push({ email: agent.actor.email, agent: true, state: "editing" });
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

// Announce that an agent (acting over MCP, with no socket of its own) just
// changed this note. People in the room see it as a distinct presence — "<account>'s
// agent", not the account's own tab — carrying an "editing" chip and a caret at
// the end of what the agent wrote, then fading once the agent goes quiet (agents
// emit no idle signal, so a fixed lifetime is the only cue we have).
export function liveAgentActivity(
  note: { id: string; content: string; version: number },
  actor: Actor,
): void {
  if (!actor.agent) return;
  const key = presenceKey(actor.email, true);
  let agents = agentPresence.get(note.id);
  if (!agents) {
    agents = new Map();
    agentPresence.set(note.id, agents);
  }
  // The agent has no cursor; stand in for "where it just wrote" by its caret at
  // the end of the current text, anchored on the tail so it relocates if the
  // note drifts.
  const caret: Omit<LiveCursor, "email" | "agent"> = {
    position: note.content.length,
    anchor: note.content.slice(-CARET_ANCHOR_CHARS),
    version: note.version,
  };
  const existing = agents.get(key);
  if (existing) {
    existing.caret = caret;
    if (existing.timer) clearTimeout(existing.timer);
  } else {
    agents.set(key, { actor, caret, timer: null });
  }
  const entry = agents.get(key)!;
  entry.timer = setTimeout(
    () => clearAgentPresence(note.id, key),
    AGENT_PRESENCE_MS,
  );
  entry.timer.unref?.();
  broadcastPresence(note.id);
  broadcastCursor(note.id, null, actor.email, { agent: true, ...caret });
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
    void identityFromHandshake(req.headers, queryEmail).then((email) => {
      if (!email) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client: Client = {
          socket: ws,
          email,
          notes: new Set(),
          carets: new Map(),
          alive: true,
        };
        clients.add(client);
        attach(client);
      });
    });
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
