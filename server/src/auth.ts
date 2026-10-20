import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import {
  apiKeyProvider,
  bearerToken,
  sessionProvider,
  headerValue,
  looksLikeApiKey,
  PASS,
  type AuthFailure,
  type Credentials,
  type Identity,
  type Match,
  type Outcome,
  type Provider,
} from "./credentials.js";

// Re-exported so an entrance can speak of an identity without importing two
// modules to say one thing.
export type {
  ApiKeyGrant,
  ApiKeyStore,
  SessionGrant,
  SessionStore,
  AuthFailure,
  CredentialKind,
  Credentials,
  Identity,
  Match,
  Outcome,
  Provider,
} from "./credentials.js";

// Which Cloudflare Access team's keys to check an assertion against, and which
// application the token has to be for. Neither has a default: an issuer and an
// audience are not secrets, but they are somebody's, and a copy of this app that
// arrived at them by inheritance would be verifying its logins against a stranger's
// Access — accepting nothing, and warning nobody.
const TEAM_DOMAIN = (process.env.CF_ACCESS_TEAM_DOMAIN ?? "")
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "")
  .trim();
const AUDIENCE = (process.env.CF_ACCESS_AUD ?? "").trim();

// Configured means both halves are named: a team without an audience would accept
// a token minted for any of that team's applications, an audience without a team
// has no keys to check it against.
export const accessIsConfigured = TEAM_DOMAIN.length > 0 && AUDIENCE.length > 0;

const ISSUER = `https://${TEAM_DOMAIN}`;
const JWKS = accessIsConfigured
  ? createRemoteJWKSet(new URL(`${ISSUER}/cdn-cgi/access/certs`))
  : null;

// What the boot line says, in one place so the sentence and the setting cannot
// drift apart.
export function accessSettings(): string {
  return accessIsConfigured
    ? `verifying assertions from ${TEAM_DOMAIN} for audience ${AUDIENCE}`
    : "not configured — set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD " +
        "(an Access assertion gets a 401)";
}

declare global {
  namespace Express {
    interface Request {
      user?: Identity;
    }
  }
}

const FAILURE_BODY: Record<AuthFailure, { error: string }> = {
  no_credential: { error: "Unauthorized" },
  invalid_token: { error: "Invalid Cloudflare Access token" },
  invalid_key: {
    error: "Invalid API key. Check the key, or mint a new one under Agents.",
  },
  invalid_session: {
    error: "This sign-in is no longer valid. Sign in again.",
  },
  no_account: {
    error:
      "This Access token has no account to act as. A service token must match MCP_SERVICE_TOKEN_ID, and MCP_AGENT_EMAIL must name the account.",
  },
};

// ------------------------------------------------------------------ chain

// The chain: the first credential a request presents is the one that is checked,
// and if it grants nobody then the request is refused without asking anyone else.
// Order is therefore load-bearing, and a provider only ever answers for its own
// credential — a new one is added to the list, not threaded through the others.
export async function resolveIdentity(
  chain: Provider[],
  credentials: Credentials,
): Promise<Outcome> {
  for (const provider of chain) {
    const outcome: Match = await provider.match(credentials);
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
// trusts the signature. A bearer token shaped like one of this app's own keys is
// left to the key provider, so neither of them guesses at the other's credential.
export function accessAssertion(headers: Credentials["headers"]): string {
  const direct = headerValue(headers, "cf-access-jwt-assertion");
  if (direct.length > 0) return direct;
  const bearer = bearerToken(headers);
  return looksLikeApiKey(bearer) ? "" : bearer;
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
// undefined when the token is not valid for this app — which includes this app
// having no team to be valid for.
export async function verifyAccessToken(
  token: string,
): Promise<JWTPayload | undefined> {
  if (JWKS === null) return undefined;
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

function lowerEmail(value: string): string {
  return value.trim().toLowerCase();
}

// The one chain, in precedence order: this app's own API key, a person's Access
// token, the machine credential the operator pinned, a session cookie this app
// signed, then the dev identity. No two of them can be mistaken for each other —
// a key is prefixed, an Access token is a signed JWT, a session arrives in a
// cookie — and `machine` is the only thing a surface adds, so no endpoint gets to
// decide on its own who is trusted, or when.
//
// A signed-in browser that also arrives through Access is served by Access: the
// cookie is the credential for deployments that have nothing else, not a way to
// step in front of the one that does.
export function providers(
  machine?: (payload: JWTPayload) => string,
): Provider[] {
  return [
    apiKeyProvider(),
    accessProvider({ verify: verifyAccessToken, machine }),
    sessionProvider(),
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
