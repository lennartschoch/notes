import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

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

export async function requireUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.header("cf-access-jwt-assertion");

  if (token) {
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      if (typeof payload.email === "string" && payload.email.length > 0) {
        req.user = { email: payload.email.trim().toLowerCase() };
        next();
        return;
      }
    } catch {
      // Invalid token: reject below.
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
