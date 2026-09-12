import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

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

  if (process.env.NODE_ENV !== "production") {
    req.user = { email: process.env.DEV_USER_EMAIL ?? "dev@localhost" };
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}
