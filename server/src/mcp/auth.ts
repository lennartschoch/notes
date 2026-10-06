import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { requireUser, verifyAccessToken } from "../auth.js";

// Identity for the MCP endpoint. It is the web identity with two additions, both
// for machines, and both say which account a machine may be. A Cloudflare Access
// service token proves a machine is talking but carries no email — while every
// note is owned by an email — so the operator names the account it stands for:
//
//   MCP_AGENT_EMAIL=agent@example.com          # identity to act as
//   MCP_SERVICE_TOKEN_ID=my-agent-token        # token common_name to accept
//
// and, for an agent that reaches this container without passing through Access
// (see isSharedSecret), a long-lived secret instead of a token:
//
//   MCP_SERVICE_TOKEN=<long random string>     # acts as MCP_AGENT_EMAIL
//
// With MCP_AGENT_EMAIL unset, machine credentials are refused and only real user
// identities (or the dev fallback) get through.

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

// The account machine credentials are allowed to act as, "" when the operator
// has not named one — in which case no machine gets in.
function agentEmail(): string {
  return envValue("MCP_AGENT_EMAIL").toLowerCase();
}

// A long-lived shared secret, for an agent that talks to this container directly
// rather than through Cloudflare Access — an Access JWT cannot do that job, both
// because it expires and because a request from a neighbouring container never
// passes through Access to be stamped with one.
//
// It is the only credential here that is not verified by Cloudflare, so it is
// deliberately narrower than one: it resolves to exactly one account, the one the
// operator named, and never to an arbitrary address the caller asks for. Requests
// arriving through the public hostname cannot use it either — Access challenges
// them before they reach the app.
function isSharedSecret(token: string): boolean {
  const secret = envValue("MCP_SERVICE_TOKEN");
  if (secret.length === 0 || token.length === 0) return false;
  const offered = Buffer.from(token);
  const expected = Buffer.from(secret);
  return (
    offered.length === expected.length && timingSafeEqual(offered, expected)
  );
}

// A bearer token in the Authorization header is an alternative to the
// cf-access-jwt-assertion header, for clients that cannot set that one.
function bearerToken(req: Request): string {
  const header = req.header("authorization") ?? "";
  if (!/^bearer\s+/i.test(header)) return "";
  return header.slice(header.indexOf(" ") + 1).trim();
}

export async function requireMcpUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token =
    (req.header("cf-access-jwt-assertion") ?? "").trim() || bearerToken(req);

  // No credential of our own: fall back to the app's rules, which is the
  // x-dev-user-email header outside production and a hard 401 inside it.
  if (token.length === 0) {
    await requireUser(req, res, next);
    return;
  }

  if (isSharedSecret(token)) {
    const mapped = agentEmail();
    if (mapped.length === 0) {
      // A misconfiguration, not a forgery: say so, rather than looking like a
      // bad credential.
      res.status(503).json({
        error:
          "MCP_SERVICE_TOKEN is set but MCP_AGENT_EMAIL is not, so there is no account to act as.",
      });
      return;
    }
    req.user = { email: mapped };
    next();
    return;
  }

  const payload = await verifyAccessToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid Cloudflare Access token" });
    return;
  }

  const email =
    typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (email.length > 0) {
    req.user = { email };
    next();
    return;
  }

  const commonName =
    typeof payload.common_name === "string" ? payload.common_name.trim() : "";
  const allowedTokenId = envValue("MCP_SERVICE_TOKEN_ID");
  const mapped = agentEmail();
  if (
    mapped.length > 0 &&
    commonName.length > 0 &&
    (allowedTokenId.length === 0 || commonName === allowedTokenId)
  ) {
    req.user = { email: mapped };
    next();
    return;
  }

  res.status(401).json({
    error:
      "Access token has no user identity. Set MCP_AGENT_EMAIL (and optionally MCP_SERVICE_TOKEN_ID) to let a service token act as an account.",
  });
}
