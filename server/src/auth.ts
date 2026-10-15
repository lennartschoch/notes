import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

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

declare global {
  namespace Express {
    interface Request {
      user?: { email: string };
    }
  }
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

// The identity behind a WebSocket handshake. WebSockets cannot carry custom
// headers from the browser, so the sources are the same as requireUser's —
// the Cloudflare Access assertion header, and the opt-in dev identity — with
// one addition for dev/test only: an ?email= query parameter. It is ignored
// unless DEV_USERS=1, exactly like the dev header.
export async function identityFromHandshake(
  headers: Record<string, string | string[] | undefined>,
  queryEmail: string | null,
): Promise<string | undefined> {
  const token = headers["cf-access-jwt-assertion"];
  if (typeof token === "string" && token.length > 0) {
    const payload = await verifyAccessToken(token);
    if (payload && typeof payload.email === "string" && payload.email) {
      return payload.email.trim().toLowerCase();
    }
    return undefined;
  }
  if (process.env.DEV_USERS === "1") {
    const header = headers["x-dev-user-email"];
    const fromHeader = typeof header === "string" ? header : undefined;
    return (
      fromHeader?.trim().toLowerCase() ||
      queryEmail?.trim().toLowerCase() ||
      process.env.DEV_USER_EMAIL ||
      "dev@localhost"
    );
  }
  return undefined;
}

export async function requireUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.header("cf-access-jwt-assertion");

  if (token) {
    const payload = await verifyAccessToken(token);
    if (payload) {
      if (typeof payload.email === "string" && payload.email.length > 0) {
        req.user = { email: payload.email.trim().toLowerCase() };
        next();
        return;
      }
    }
    res.status(401).json({ error: "Invalid Cloudflare Access token" });
    return;
  }

  // An explicit dev/test identity via header lets end-to-end tests drive two
  // distinct users against one server. It is opt-in (DEV_USERS=1) rather than
  // "anything but production", so a deployment that forgets to set NODE_ENV
  // fails closed: without the flag, Cloudflare Access is the only identity
  // source and a missing header is a hard 401.
  if (process.env.DEV_USERS === "1") {
    const devEmail = req.header("x-dev-user-email")?.trim().toLowerCase();
    req.user = {
      email: devEmail || process.env.DEV_USER_EMAIL || "dev@localhost",
    };
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}
