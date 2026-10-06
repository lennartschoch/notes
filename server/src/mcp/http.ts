import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { requireMcpUser } from "./auth.js";
import {
  closeSession,
  dropSession,
  expireIdleSessions,
  getSession,
  openSession,
  sessionCount,
  touchSession,
  type McpSession,
} from "./hub.js";
import { buildMcpServer } from "./server.js";

// Streamable HTTP endpoint for AI agents, mounted inside the app so it shares
// the deployment and the Cloudflare Access identity the web UI signs in with:
// an agent talks to https://<host>/mcp and edits notes as itself.

const IDLE_TIMEOUT_MS = Number(
  process.env.MCP_IDLE_TIMEOUT_MS ?? 30 * 60 * 1000,
);
const MAX_SESSIONS = Number(process.env.MCP_MAX_SESSIONS ?? 25);
const BODY_LIMIT = process.env.MCP_BODY_LIMIT ?? "4mb";

export function mcpPath(): string {
  const raw = process.env.MCP_PATH ?? "/mcp";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function reject(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

// Resolves the session an Mcp-Session-Id header points at, answering the
// request itself (400/404) when it does not point at a live one.
function resolveSession(req: Request, res: Response): McpSession | undefined {
  const id = req.header("mcp-session-id");
  if (!id) {
    reject(
      res,
      400,
      "Missing Mcp-Session-Id header. POST an initialize request to this endpoint first.",
    );
    return undefined;
  }
  const session = getSession(id);
  if (!session) {
    reject(
      res,
      404,
      "Unknown or closed MCP session. Run the initialize handshake again.",
    );
    return undefined;
  }
  touchSession(id);
  return session;
}

async function handlePost(req: Request, res: Response): Promise<void> {
  // Requests belonging to an established session go straight to its transport,
  // which owns the connection the session was opened on.
  if (req.header("mcp-session-id")) {
    const session = resolveSession(req, res);
    if (!session) return;
    // req.body was already read by the JSON parser mounted on this route, so
    // the stream is gone and the transport must be handed the parsed body.
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  if (!isInitializeRequest(req.body)) {
    reject(
      res,
      400,
      "Only an initialize request may start a session; send the Mcp-Session-Id header returned by initialize with every later request.",
    );
    return;
  }
  if (sessionCount() >= MAX_SESSIONS) {
    reject(res, 503, `Too many open MCP sessions (limit ${MAX_SESSIONS}).`);
    return;
  }

  const email = req.user!.email;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  // A client that hangs up during the handshake closes its transport; the
  // session must then not be registered.
  let closed = false;
  // Set before connect(): the SDK chains a handler that is already on the
  // transport rather than replacing it. The transport exposes a single
  // assignment-style handler, by design.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onclose = () => {
    closed = true;
    dropSession(transport);
  };

  const server = buildMcpServer(email);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);

  // The session id only exists once the initialize request has been handled,
  // and a client that hung up during the handshake must not be registered.
  const id = transport.sessionId;
  if (id && !closed) {
    openSession(id, {
      server,
      transport,
      email,
      openedAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    console.log(
      `MCP session ${id} opened by ${email} (${sessionCount()} open)`,
    );
  }
}

// Errors must not escape into Express' HTML error page: an MCP client expects
// either a JSON body it can read or nothing at all.
function guard(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!res.headersSent) {
        reject(res, 500, "MCP request failed.");
      }
    }
  };
}

export function mountMcp(app: Express): void {
  const path = mcpPath();

  // Registered ahead of the app-wide JSON parser, with its own limit, so the
  // streamable-HTTP transport receives a body it recognises. requireMcpUser
  // runs first: an anonymous caller is turned away before its body is buffered.
  app.post(
    path,
    requireMcpUser,
    express.json({ limit: BODY_LIMIT }),
    guard(handlePost),
  );

  // GET opens the long-lived stream a client receives server-initiated
  // messages on — including the resource-change notifications from hub.ts.
  app.get(
    path,
    requireMcpUser,
    guard(async (req, res) => {
      const session = resolveSession(req, res);
      if (!session) return;
      // No body parser on this route: the request has no body to parse.
      await session.transport.handleRequest(req, res);
    }),
  );

  app.delete(
    path,
    requireMcpUser,
    guard(async (req, res) => {
      const session = resolveSession(req, res);
      if (!session) return;
      const id = String(req.header("mcp-session-id"));
      await session.transport.close();
      closeSession(id);
      console.log(`MCP session ${id} closed (${sessionCount()} open)`);
      res.json({ ok: true });
    }),
  );

  const sweeper = setInterval(() => {
    void expireIdleSessions(IDLE_TIMEOUT_MS);
  }, 60_000);
  // Do not keep the process alive for the sweep alone.
  sweeper.unref();
}
