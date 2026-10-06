import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const TEAM_DOMAIN = (
  process.env.CF_ACCESS_TEAM_DOMAIN ?? "lennartschoch.cloudflareaccess.com"
)
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");
const AUDIENCE =
  process.env.CF_ACCESS_AUD ??
  "679c3d2a2a09ca7734cc9280a435035173c65e68ff08067e4665d216f75a563e";

const ISSUER = `https://${TEAM_DOMAIN}`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/cdn-cgi/access/certs`));

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

  // Outside production, allow an explicit dev/test identity via header so
  // end-to-end tests can drive two distinct users against one server. Cloudflare
  // Access is the only identity source in production, where this is disabled.
  if (process.env.NODE_ENV !== "production") {
    const devEmail = req.header("x-dev-user-email")?.trim().toLowerCase();
    req.user = {
      email: devEmail || process.env.DEV_USER_EMAIL || "dev@localhost",
    };
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}
