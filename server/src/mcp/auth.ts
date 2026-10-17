import type { NextFunction, Request, Response } from "express";
import type { JWTPayload } from "jose";
import { authorizeWith, providers } from "../auth.js";

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

// The MCP identity: the app's own chain, plus the one thing only this endpoint
// asks for — the operator's mapping from a machine credential to the account it
// may act as. Which credentials are trusted, and in what order, is not decided
// here, so a token means the same account over MCP as over the web UI.
export function requireMcpUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return authorizeWith(
    providers((payload) => accountForPayload(payload, accessConfig())),
    req,
    res,
    next,
  );
}
