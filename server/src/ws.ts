import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  type LiveClientMessage,
  type LiveEditor,
  type LiveNoteSnapshot,
  type LiveServerMessage,
  type PresenceState,
} from "shared";
import { identityFromHandshake } from "./auth.js";
import { canView, peekNote } from "./store.js";

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
  alive: boolean;
}

const clients = new Set<Client>();
const rooms = new Map<string, Set<Client>>();
const presence = new Map<string, Map<Client, PresenceState>>();

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
  const inRoom = presence.get(noteId);
  if (!inRoom) return [];
  return Array.from(inRoom.entries()).map(([client, state]) => ({
    email: client.email,
    state,
  }));
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
    } else if (message.type === "unsubscribe") {
      forget(client, message.noteId);
    } else if (message.type === "presence") {
      setPresence(client, message.noteId, message.state);
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
