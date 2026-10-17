import type { CorsOptions } from "cors";

// What the app believes about the network in front of it.
//
// Two things an operator has to say out loud, because guessing them is how a
// deployment ends up trusting a header anybody can send, or refusing to set a
// cookie because a proxy said nothing.

// The MCP endpoint is useful from a browser — the MCP inspector is one — and that
// is the only reason this app ever answers a cross-origin request. By default it
// answers none: every supported deployment serves the API, the live channel and
// the web client from one origin (in development Vite proxies `/api`, `/ws` and
// `/mcp`), and a same-origin page needs no CORS at all.
//
// Agents that are not browsers — curl, an SDK, a coding agent — never needed it
// either: CORS is a browser rule, and it has never stopped a terminal.
export const CORS_ALLOW_ORIGINS = "CORS_ALLOW_ORIGINS";

// The response headers a streamable-HTTP MCP client has to be able to *read*
// cross-origin: without the session id it cannot make a second request, and
// without the last-event id it cannot resume the message stream.
const EXPOSED_HEADERS = ["mcp-session-id", "last-event-id"];

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// Origins allowed to call the API from a browser, or an empty list for
// same-origin only. `*` is deliberately not honoured: an origin of `*` next to an
// app that keeps a session cookie is a claim that any page on the internet may
// read this account, which is not what anybody means when they type it.
export function allowedOrigins(): string[] {
  return list(process.env[CORS_ALLOW_ORIGINS]);
}

export function corsOptions(): CorsOptions {
  const origins = allowedOrigins();
  return {
    // `false` is the cors module's "answered by nothing of mine": no
    // Access-Control-Allow-Origin header goes out, so the browser keeps the
    // request same-origin-only.
    origin: origins.length > 0 ? origins : false,
    // Never credentials. The session cookie is `SameSite=Lax` and bound to this
    // origin's own host; allowing it cross-site would be a second, weaker door
    // beside it, and no legitimate caller here needs one.
    credentials: false,
    allowedHeaders: [
      "authorization",
      "content-type",
      "cf-access-client-id",
      "cf-access-client-secret",
      "mcp-session-id",
      "mcp-protocol-version",
      "last-event-id",
    ],
    exposedHeaders: EXPOSED_HEADERS,
    maxAge: 600,
  };
}

// The one thing in a request a client can forge when nothing verifies it is the
// address it claims to come from — so this app assumes nobody is in front of it,
// which is also the assumption that keeps a LAN deployment from reading
// `X-Forwarded-For` off a passing request.
export const TRUST_PROXY = "TRUST_PROXY";

// How many hops to believe, or which addresses. `false` by default.
//
//   TRUST_PROXY=1                     one reverse proxy (Caddy, Traefik, nginx)
//   TRUST_PROXY=2                     a tunnel and a proxy
//   TRUST_PROXY=103.21.244.0/22       Cloudflare's addresses, when you can name them
export function trustProxySetting(): boolean | number | string | string[] {
  const entries = list(process.env[TRUST_PROXY]);
  if (entries.length === 0) return false;
  if (entries.length === 1) {
    const only = entries[0]!;
    if (only === "false") return false;
    if (only === "true") return true;
    if (/^\d+$/.test(only)) return Number(only);
    return only;
  }
  return entries;
}
