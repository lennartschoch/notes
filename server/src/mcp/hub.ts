import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { liveAgentLeaveSession } from "../ws.js";

// Registry of the MCP sessions that are currently open. It lives apart from the
// HTTP layer because a change made through one connection has to be announced
// to the others: every session exposes the same notes as resources, and a
// client holding `notes://index` should learn that it went stale.

export interface McpSession {
  // The id clients send in the Mcp-Session-Id header. It is also what live
  // presence keys an agent's carets by, so closing a connection takes them out
  // of the rooms it was standing in.
  sessionId: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  email: string;
  // True when the session is an agent acting on an account's behalf (see
  // MCP.md). Surfaced in the header log line and reserved for the same
  // "who is really driving" distinction the write path uses.
  agent?: boolean;
  openedAt: number;
  lastSeenAt: number;
}

const sessions = new Map<string, McpSession>();

export function openSession(id: string, session: McpSession): void {
  sessions.set(id, session);
}

export function getSession(id: string): McpSession | undefined {
  return sessions.get(id);
}

export function touchSession(id: string): void {
  const session = sessions.get(id);
  if (session) session.lastSeenAt = Date.now();
}

export function closeSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  // A person watching a note should not keep watching a caret for an agent whose
  // connection has already ended.
  liveAgentLeaveSession(session.sessionId);
}

// Removes the session belonging to a transport, whatever it was registered as.
export function dropSession(transport: StreamableHTTPServerTransport): void {
  for (const [id, session] of sessions) {
    if (session.transport === transport) closeSession(id);
  }
}

export function sessionCount(): number {
  return sessions.size;
}

// Tells every open session that a note changed, so cached index and note
// resources are known to be stale. A session that has not finished its
// handshake cannot accept notifications and is simply skipped: its next list
// or read returns current data anyway.
export function noteChanged(noteId: string): void {
  const uri = `note://${noteId}`;
  for (const session of sessions.values()) {
    try {
      session.server.server.notification({
        method: "notifications/resources/updated",
        params: { uri },
      });
      session.server.sendResourceListChanged();
    } catch {
      // Not ready for notifications.
    }
  }
}

// Sessions whose client vanished (crashed agent, missed DELETE) are closed once
// they have been quiet for idleMs.
export async function expireIdleSessions(idleMs: number): Promise<void> {
  const cutoff = Date.now() - idleMs;
  for (const [id, session] of sessions) {
    if (session.lastSeenAt >= cutoff) continue;
    sessions.delete(id);
    await session.transport.close().catch(() => {});
    console.log(`MCP session ${id} expired (idle)`);
  }
}
