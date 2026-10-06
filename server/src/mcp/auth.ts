import type { NextFunction, Request, Response } from "express";
import { requireUser, verifyAccessToken } from "../auth.js";

// Identity for the MCP endpoint. It is the web identity with one addition: a
// Cloudflare Access *service token* proves a machine is talking, and a service
// token carries no email — while every note is owned by an email. So an
// operator who wants headless agents has to say explicitly which account a
// service token acts as, and which token is allowed to be that account:
//
//   MCP_AGENT_EMAIL=agent@example.com          # identity to act as
//   MCP_SERVICE_TOKEN_ID=my-agent-token        # token common_name to accept
//
// With MCP_AGENT_EMAIL unset, service tokens are refused and only real user
// identities (or the dev fallback) get through.

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
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

  const agentEmail = envValue("MCP_AGENT_EMAIL");
  const commonName =
    typeof payload.common_name === "string" ? payload.common_name.trim() : "";
  const allowedTokenId = envValue("MCP_SERVICE_TOKEN_ID");
  if (
    agentEmail.length > 0 &&
    commonName.length > 0 &&
    (allowedTokenId.length === 0 || commonName === allowedTokenId)
  ) {
    req.user = { email: agentEmail };
    next();
    return;
  }

  res.status(401).json({
    error:
      "Access token has no user identity. Set MCP_AGENT_EMAIL (and optionally MCP_SERVICE_TOKEN_ID) to let a service token act as an account.",
  });
}
