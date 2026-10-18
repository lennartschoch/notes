import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { requireUser } from "./auth.js";
import {
  accessAssertionsVerified,
  clearSessionCookie,
  setSessionCookie,
  type Identity,
} from "./credentials.js";
import { parseBody, sourceAddress } from "./body.js";
import {
  hasAccounts,
  normaliseEmail,
  passwordProblem,
  recordSignIn,
  setPassword,
  signIn,
} from "./accounts.js";
import { attempt, failed, succeeded } from "./guard.js";
import {
  createSession,
  listSessions,
  revokeSession,
  revokeSessions,
  sessionLifetimeMs,
} from "./sessions.js";

// Signing in with a password, and the sessions that result.
//
// This is the door for a person when Cloudflare Access is not standing in front
// of the app: the same account, reached by a credential this app issues, stores,
// and can take back.

const loginBody = z.object({
  email: z.string().catch(""),
  password: z.string().catch(""),
});

const passwordBody = z.object({
  current: z.string().catch(""),
  next: z.string().catch(""),
});

// A session cookie is a credential the browser sends on its own, so it is not
// something a caller from another site can be allowed to wave at the app. `Lax`
// already keeps it out of cross-site posts; `Secure` is what keeps it off the wire
// in the first place, and only an HTTPS connection can carry one — which, behind a
// proxy, depends on the operator having said the proxy may be believed.
function isSecure(req: Request): boolean {
  return req.secure === true;
}

// Keys and sessions are what a person sets up. A machine credential can spend the
// account it was minted from, but cannot mint, list or rename the others — a
// credential that hands out credentials outlives its own revocation — and it has
// no business reading which device the person signed in from.
export function requireHuman(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.user?.via === "apikey") {
    res.status(403).json({
      error:
        "An API key cannot manage API keys or sessions. Do it as the person who owns them.",
    });
    return;
  }
  next();
}

const TOO_MANY = (seconds: number) =>
  `Too many failed sign-ins. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;

export function mountSignIn(app: Express): void {
  // What a browser needs before anybody has identified itself: is there a
  // password door at all, or is this deployment standing behind Access?
  app.get("/api/config", (_req, res) => {
    res.json({
      accounts: hasAccounts(),
      // False only on a development switch, but worth telling the client about:
      // with it off, an Access header is a claim rather than a proof.
      accessVerified: accessAssertionsVerified(),
      // How long a sign-in lasts when it is not used, so a client can say so.
      sessionHours: Math.round(sessionLifetimeMs / 3_600_000),
    });
  });

  app.post("/api/login", async (req, res) => {
    const body = parseBody(loginBody, req, res);
    if (!body) return;
    const email = normaliseEmail(body.email);
    const from = sourceAddress(req);
    const trail = `${email}|${from}`;

    const allowed = attempt(trail);
    if (!allowed.allowed) {
      res.status(429).json({ error: TOO_MANY(allowed.retryAfterSeconds) });
      return;
    }

    const result = await signIn(email, body.password);
    if (result.status !== "ok") {
      const decision = failed(trail);
      // "No account by that name" and "wrong password" are one answer, and it is
      // not the one that says which of them it was. An inactive account is only
      // reachable by someone who already has its password, so that one may be
      // named.
      const message =
        result.status === "inactive"
          ? "That account is not active. Ask whoever runs this app."
          : "Wrong email address or password.";
      res.status(decision.allowed ? 401 : 429).json({
        error: decision.allowed
          ? message
          : TOO_MANY(decision.retryAfterSeconds),
      });
      return;
    }

    succeeded(trail);
    const { token } = await createSession(
      result.email,
      String(req.headers["user-agent"] ?? ""),
    );
    await recordSignIn(result.email, from);
    setSessionCookie(res, token, isSecure(req), sessionLifetimeMs / 1000);
    console.log(`Signed in: ${result.email} from ${from}`);
    res.json({ email: result.email });
  });

  // Signing out ends this session; `DELETE /api/sessions` ends all of them.
  app.post("/api/logout", requireUser, async (req, res) => {
    const user: Identity | undefined = req.user;
    if (user?.via === "session" && user.sessionId) {
      await revokeSession(user.email, user.sessionId);
    }
    clearSessionCookie(res, isSecure(req));
    res.status(204).end();
  });

  app.get("/api/sessions", requireUser, requireHuman, (req, res) => {
    res.json({
      // Which of these the caller is holding, so the list can say "this device".
      current: req.user?.sessionId ?? null,
      sessions: listSessions(req.user!.email),
    });
  });

  app.delete(
    "/api/sessions/:id",
    requireUser,
    requireHuman,
    async (req, res) => {
      const removed = await revokeSession(
        req.user!.email,
        String(req.params.id),
      );
      if (!removed) {
        res.status(404).json({ error: "That sign-in is already gone." });
        return;
      }
      res.status(204).end();
    },
  );

  // Every sign-in this account has, the caller's own included — which is the
  // point: the answer to finding a device you do not own is "gone", not "gone
  // except the one you are typing on".
  app.delete("/api/sessions", requireUser, requireHuman, async (req, res) => {
    const count = await revokeSessions(req.user!.email);
    clearSessionCookie(res, isSecure(req));
    res.json({ revoked: count });
  });

  // Changing a password signs everybody out, the caller included: a password
  // change is what a person reaches for when a session has outlived its welcome.
  app.post("/api/password", requireUser, requireHuman, async (req, res) => {
    const body = parseBody(passwordBody, req, res);
    if (!body) return;
    const problem = passwordProblem(body.next);
    if (problem.length > 0) {
      res.status(400).json({ error: problem });
      return;
    }
    const proved = await signIn(req.user!.email, body.current);
    if (proved.status !== "ok") {
      res.status(401).json({ error: "That is not your current password." });
      return;
    }
    if (!(await setPassword(req.user!.email, body.next))) {
      res.status(404).json({ error: "No account here by that address." });
      return;
    }
    const everywhere = await revokeSessions(req.user!.email);
    clearSessionCookie(res, isSecure(req));
    console.log(
      `Password changed for ${req.user!.email}; ${everywhere} sign-in${everywhere === 1 ? "" : "s"} ended`,
    );
    res.json({ ok: true, signedOutEverywhere: true });
  });
}
