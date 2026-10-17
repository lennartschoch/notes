import type {
  LiveClientMessage,
  LiveCursor,
  LiveEditor,
  LiveNoteSnapshot,
  LiveServerMessage,
  PresenceState,
} from "shared";

// The client side of the live channel. One socket per tab: it subscribes to
// the notes that are open, pushes presence updates, and hands incoming note
// snapshots and rosters to the app. Reconnects with backoff and replays the
// subscription set on every open, so a dropped tunnel costs a blink rather
// than a lost update. Everything is best-effort: when the socket is down the
// app keeps working on its REST polling alone.

export type LiveStatus = "connecting" | "online" | "offline";

export interface LiveHandlers {
  note(note: LiveNoteSnapshot): void;
  gone(noteId: string): void;
  presence(noteId: string, editors: LiveEditor[]): void;
  cursor(noteId: string, cursor: LiveCursor): void;
  status(status: LiveStatus): void;
}

// Used until the app hands over its real handlers from an effect (the real
// ones close over refs and must not be captured during render).
export const idleLiveHandlers: LiveHandlers = {
  note: () => {},
  gone: () => {},
  presence: () => {},
  cursor: () => {},
  status: () => {},
};

export interface LiveSocket {
  setHandlers(handlers: LiveHandlers): void;
  // `email` is only read by a DEV_USERS server (browsers cannot attach
  // headers to a WebSocket handshake); production ignores it.
  start(email: string): void;
  stop(): void;
  subscribe(noteId: string): void;
  unsubscribe(noteId: string): void;
  setPresence(noteId: string, state: PresenceState): void;
  // Where the local caret moved; null clears it. Ephemeral, never replayed
  // after a reconnect — the next keystroke re-publishes it.
  setCursor(
    noteId: string,
    cursor: { position: number; anchor: string; version: number } | null,
  ): void;
}

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

export function createLive(initialHandlers: LiveHandlers): LiveSocket {
  let handlers = initialHandlers;
  let socket: WebSocket | null = null;
  let email = "";
  let stopped = true;
  let backoffMs = MIN_BACKOFF_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // What the app wants to be subscribed to, independent of socket state;
  // replayed on every successful open.
  const subscriptions = new Map<string, PresenceState>();

  function send(message: LiveClientMessage): void {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function connect(): void {
    if (stopped || socket) return;
    handlers.status("connecting");
    const url =
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}` +
      `/ws?email=${encodeURIComponent(email)}`;
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      backoffMs = MIN_BACKOFF_MS;
      handlers.status("online");
      for (const [noteId, state] of subscriptions) {
        send({ type: "subscribe", noteId });
        send({ type: "presence", noteId, state });
      }
    };
    ws.onmessage = (event) => {
      let message: LiveServerMessage;
      try {
        message = JSON.parse(String(event.data)) as LiveServerMessage;
      } catch {
        return;
      }
      if (message.type === "note") handlers.note(message.note);
      else if (message.type === "gone") handlers.gone(message.noteId);
      else if (message.type === "presence")
        handlers.presence(message.noteId, message.editors);
      else if (message.type === "cursor")
        handlers.cursor(message.noteId, message.cursor);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      if (stopped) return;
      handlers.status("offline");
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    };
    ws.onerror = () => {
      // onclose follows and carries the reconnect.
    };
  }

  return {
    setHandlers: (next) => {
      handlers = next;
    },
    start: (identity) => {
      email = identity;
      if (!stopped) return;
      stopped = false;
      connect();
    },
    stop: () => {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      socket?.close();
      socket = null;
    },
    subscribe: (noteId) => {
      if (subscriptions.has(noteId)) return;
      subscriptions.set(noteId, "viewing");
      send({ type: "subscribe", noteId });
    },
    unsubscribe: (noteId) => {
      if (!subscriptions.delete(noteId)) return;
      send({ type: "unsubscribe", noteId });
    },
    setPresence: (noteId, state) => {
      if (!subscriptions.has(noteId)) return;
      if (subscriptions.get(noteId) === state) return;
      subscriptions.set(noteId, state);
      send({ type: "presence", noteId, state });
    },
    setCursor: (noteId, cursor) => {
      if (!subscriptions.has(noteId)) return;
      if (!cursor) {
        send({
          type: "cursor",
          noteId,
          position: null,
          anchor: "",
          version: 0,
        });
        return;
      }
      send({ type: "cursor", noteId, ...cursor });
    },
  };
}
