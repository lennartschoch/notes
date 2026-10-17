import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Actor } from "./types.js";

const TEAM_DOMAIN = (
  process.env.CF_ACCESS_TEAM_DOMAIN ?? "example.cloudflareaccess.com"
)
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");
const AUDIENCE =
  process.env.CF_ACCESS_AUD ??
  "32eafc7626e974616deaf0dc3ce63d7bcbed58a2731e84d06bc3cdf1b53c4228";

const ISSUER = `https://${TEAM_DOMAIN}`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/cdn-cgi/access/certs`));

// The defaults above are this deployment's own team. A production process
// that did not set them is verifying tokens against somebody's Access, so
// say so loudly at boot instead of failing mysteriously at first login.
if (
  process.env.NODE_ENV === "production" &&
  (!process.env.CF_ACCESS_TEAM_DOMAIN || !process.env.CF_ACCESS_AUD)
) {
  console.warn(
    "Warning: running in production with the built-in Cloudflare Access team domain/audience. " +
      "Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD to your own values.",
  );
}

// Which kind of credential granted an identity. Named after the credential,
// never after anything the caller says about itself, so a machine cannot
// describe its way into appearing to be a person.
export type CredentialKind = "access" | "dev";

// An identity, ready to be used as an Actor. `via` records where the grant came
// from, for this app's own bookkeeping; whether an agent was driving the account
// is part of every actor, and is derived from the credential, never claimed.
export interface Identity extends Actor {
  via: CredentialKind;
}

declare global {
  namespace Express {
    interface Request {
      user?: Identity;
    }
  }
}

// ------------------------------------------------------------------ chain

// Why a request was turned away. The difference matters to the caller: a token
// that did not verify is Cloudflare's problem, a token that grants no account is
// a setting this app's operator has not made.
export type AuthFailure = "no_credential" | "invalid_token" | "no_account";

const FAILURE_BODY: Record<AuthFailure, { error: string }> = {
  no_credential: { error: "Unauthorized" },
  invalid_token: { error: "Invalid Cloudflare Access token" },
  no_account: {
    error:
      "This Access token has no account to act as. A service token must match MCP_SERVICE_TOKEN_ID, and MCP_AGENT_EMAIL must name the account.",
  },
};

// Everything a provider may read a credential off: the headers of an HTTP
// request or of a WebSocket upgrade — both are the same bag — plus the one thing
// a browser socket cannot carry, described at `devProvider`.
export interface Credentials {
  headers: Record<string, string | undefined | string[]>;
  queryEmail?: string | null;
}

type Match =
  // Presents none of this provider's credentials: ask the next one.
  | { kind: "pass" }
  | { kind: "identity"; identity: Identity }
  // A credential of ours that grants nobody: the request is refused, and nothing
  // further is asked.
  | { kind: "deny"; reason: AuthFailure };

// What every entrance gets back: an identity, or the one reason there is none.
export type Outcome =
  | { ok: true; identity: Identity }
  | { ok: false; reason: AuthFailure };

export interface Provider {
  kind: CredentialKind;
  match(credentials: Credentials): Promise<Match>;
}

const PASS: Match = { kind: "pass" };

function headerValue(headers: Credentials["headers"], name: string): string {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value.trim() : "";
}

function lowerEmail(value: string): string {
  return value.trim().toLowerCase();
}

// The chain: the first credential a request presents is the one that is checked,
// and if it grants nobody then the request is refused without asking anyone else.
// Order is therefore load-bearing, and a provider only ever answers for its own
// credential — a new one is added to the list, not threaded through the others.
export async function resolveIdentity(
  chain: Provider[],
  credentials: Credentials,
): Promise<Outcome> {
  for (const provider of chain) {
    const outcome = await provider.match(credentials);
    if (outcome.kind === "identity") {
      return { ok: true, identity: outcome.identity };
    }
    if (outcome.kind === "deny") return { ok: false, reason: outcome.reason };
  }
  return { ok: false, reason: "no_credential" };
}

// ------------------------------------------------------------- providers

// The Access assertion, wherever a client put it: the header Cloudflare sets,
// or — for clients that cannot set that one — Authorization: Bearer. Verified
// identically either way, which is why a request that bypasses Access cannot
// forge the first: an unsigned header is not a token, and this app only ever
// trusts the signature.
export function accessAssertion(headers: Credentials["headers"]): string {
  const direct = headerValue(headers, "cf-access-jwt-assertion");
  if (direct.length > 0) return direct;
  const authorization = headerValue(headers, "authorization");
  if (!/^bearer\s+/i.test(authorization)) return "";
  return authorization.slice(authorization.indexOf(" ") + 1).trim();
}

// A machine credential (an Access service token) carries no email, so it needs
// someone to say which account it may act as. Only the MCP endpoint asks, and it
// is the operator's mapping in mcp/auth.ts, never a claim in the token.
export interface AccessOptions {
  verify: (token: string) => Promise<JWTPayload | undefined>;
  machine?: (payload: JWTPayload) => string;
}

export function accessProvider({ verify, machine }: AccessOptions): Provider {
  return {
    kind: "access",
    async match({ headers }) {
      const token = accessAssertion(headers);
      if (token.length === 0) return PASS;
      const payload = await verify(token);
      if (!payload) return { kind: "deny", reason: "invalid_token" };

      const email =
        typeof payload.email === "string" ? lowerEmail(payload.email) : "";
      if (email.length > 0) {
        // A person acts as themselves, over MCP exactly as over the web UI.
        // Nothing in the token can make a person an agent: that is a fact about
        // the credential, and a person's credential is not one (see mcp/auth.ts).
        return { kind: "identity", identity: { email, via: "access" } };
      }
      const account = machine?.(payload) ?? "";
      if (account.length === 0) return { kind: "deny", reason: "no_account" };
      return {
        kind: "identity",
        identity: { email: account, agent: true, via: "access" },
      };
    },
  };
}

// Verifies an Access JWT against the team's JWKS and returns its claims, or
// undefined when the token is not valid for this app.
export async function verifyAccessToken(
  token: string,
): Promise<JWTPayload | undefined> {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return payload;
  } catch {
    return undefined;
  }
}

// The dev/test identity. An explicit header rather than "anything but
// production", so a deployment that forgets to set NODE_ENV fails closed: without
// the flag Access is the only identity source and a missing credential is a hard
// 401. It is also the only provider that answers for `x-dev-agent`, because it
// is the only one with no signature to derive machine-ness from.
export function devProvider(): Provider {
  return {
    kind: "dev",
    async match({ headers, queryEmail }) {
      if (process.env.DEV_USERS !== "1") return PASS;
      const email =
        lowerEmail(headerValue(headers, "x-dev-user-email")) ||
        lowerEmail(queryEmail ?? "") ||
        (process.env.DEV_USER_EMAIL ?? "dev@localhost");
      const agent = headerValue(headers, "x-dev-agent") === "1";
      return {
        kind: "identity",
        identity: agent
          ? { email, agent: true, via: "dev" }
          : { email, via: "dev" },
      };
    },
  };
}

// The one chain, in precedence order: a person's Access token, then the machine
// credential the operator pinned, then the dev identity. `machine` is the only
// thing a surface adds — the MCP endpoint supplies the mapping, and cannot
// otherwise reorder who is asked, or when.
export function providers(
  machine?: (payload: JWTPayload) => string,
): Provider[] {
  return [
    accessProvider({ verify: verifyAccessToken, machine }),
    devProvider(),
  ];
}

// ------------------------------------------------------------- entrances

// The identity behind a WebSocket handshake, or undefined when the socket has
// none. WebSockets get the same chain as requests, with the addition the dev
// provider already guards: an ?email= query parameter, honoured only under
// DEV_USERS, because a browser cannot set a header on a socket.
export async function identityFromHandshake(
  credentials: Credentials,
): Promise<Identity | undefined> {
  const outcome = await resolveIdentity(providers(), credentials);
  return outcome.ok ? outcome.identity : undefined;
}

export async function requireUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return authorizeWith(providers(), req, res, next);
}

// Shared by every entrance: an identity is put on the request, and one reason is
// written to the response.
export async function authorizeWith(
  chain: Provider[],
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const outcome = await resolveIdentity(chain, { headers: req.headers });
  if (outcome.ok) {
    req.user = outcome.identity;
    next();
    return;
  }
  res.status(401).json(FAILURE_BODY[outcome.reason]);
}
