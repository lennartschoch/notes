import type { NextFunction, Request, Response } from "express";
import type { JWTPayload } from "jose";
import { requireUser, verifyAccessToken } from "../auth.js";

// Identity for the MCP endpoint: the app's own, plus one mapping for machines.
//
// The credential is a Cloudflare Access service token. An agent sends
// CF-Access-Client-Id and CF-Access-Client-Secret to the Access-protected
// hostname; Access validates them and forwards the request carrying an
// application token. So this app only ever sees a signed JWT — the same
// verification a person gets, and no secret of ours to store, rotate or expire.
//
// One thing is missing: a service-token JWT has no email (its identity is
// common_name, the Client ID) while every note is owned by an email. So the
// operator names both halves of the pairing:
//
//   MCP_AGENT_EMAIL=agent@example.com             # account to act as
//   MCP_SERVICE_TOKEN_ID=<CF-Access-Client-Id>    # the token allowed to be it
//
// The token id is required rather than a nicety. Accepting "any service token
// in this organization" would quietly widen the door the day a second token is
// created for something else.
//
// There is deliberately no second, self-issued credential: one way in, and
// Cloudflare is the one who checks it.

export type AccessConfig = {
  agentEmail: string;
  serviceTokenId: string;
};

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

function accessConfig(): AccessConfig {
  return {
    agentEmail: envValue("MCP_AGENT_EMAIL").toLowerCase(),
    serviceTokenId: envValue("MCP_SERVICE_TOKEN_ID"),
  };
}

// Which account an Access payload may act as, or "" when it may not. Exported so
// the mapping is testable on its own: the signature check in front of it is
// Cloudflare's, and only a real token can exercise it.
export function accountForPayload(
  payload: JWTPayload,
  config: AccessConfig,
): string {
  const email =
    typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  // Checked first on purpose. A payload with an email is a person, and gets
  // their own account — never the mapped machine one, even if it also carries a
  // common_name.
  if (email.length > 0) return email;

  const commonName =
    typeof payload.common_name === "string" ? payload.common_name.trim() : "";
  if (commonName.length === 0) return "";
  if (config.serviceTokenId.length === 0) return "";
  if (commonName !== config.serviceTokenId) return "";
  return config.agentEmail;
}

// The Access application token, in the header Access sets or — for clients that
// cannot set that one — as a bearer token. Verified identically either way.
function accessAssertion(req: Request): string {
  const header = req.header("cf-access-jwt-assertion") ?? "";
  if (header.trim().length > 0) return header.trim();
  const authorization = req.header("authorization") ?? "";
  if (!/^bearer\s+/i.test(authorization)) return "";
  return authorization.slice(authorization.indexOf(" ") + 1).trim();
}

export async function requireMcpUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = accessAssertion(req);

  // No Access token at all: fall back to the app's rules, which is the
  // x-dev-user-email header only while DEV_USERS=1 and a hard 401 everywhere
  // else.
  if (token.length === 0) {
    await requireUser(req, res, next);
    return;
  }

  const payload = await verifyAccessToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid Cloudflare Access token" });
    return;
  }

  const account = accountForPayload(payload, accessConfig());
  if (account.length > 0) {
    req.user = { email: account };
    next();
    return;
  }

  res.status(401).json({
    error:
      "This Access token has no account to act as. A service token must match MCP_SERVICE_TOKEN_ID, and MCP_AGENT_EMAIL must name the account.",
  });
}
