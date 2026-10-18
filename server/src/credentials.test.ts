import { test } from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";
import {
  HOST_COOKIE,
  PLAIN_COOKIE,
  accessAssertionsVerified,
  clearSessionCookie,
  configureSessionStore,
  cookieValue,
  sessionCookieValue,
  sessionProvider,
  setSessionCookie,
  type SessionGrant,
} from "./credentials.js";
import { providers, resolveIdentity } from "./auth.js";

// The session cookie: what it looks like on the wire, and what it is worth to the
// chain. The store behind it is sessions.test.ts; here the lookup is a lookup.

function header(...pairs: string[]): Record<string, string> {
  return { cookie: pairs.join("; ") };
}

test("the cookie is read from wherever the browser put it", () => {
  assert.equal(cookieValue("notes_session=abc", [PLAIN_COOKIE]), "abc");
  assert.equal(
    cookieValue(`other=1; ${HOST_COOKIE}=strong; another=2`, [HOST_COOKIE]),
    "strong",
  );
  // Neither name, or no header at all.
  assert.equal(cookieValue("other=1", [PLAIN_COOKIE]), "");
  assert.equal(cookieValue(undefined, [PLAIN_COOKIE]), "");
  assert.equal(sessionCookieValue(header("theme=dark")), "");
  assert.equal(sessionCookieValue(header(`${PLAIN_COOKIE}=token`)), "token");
  // A value with an equals sign in it is still one value.
  assert.equal(cookieValue(`${PLAIN_COOKIE}=a=b=c`, [PLAIN_COOKIE]), "a=b=c");
});

function recorder() {
  const sent: string[] = [];
  const res = {
    append: (name: string, value: string) => {
      if (name === "Set-Cookie") sent.push(value);
      return res;
    },
  } as unknown as Response;
  return { res, sent };
}

test("an HTTPS sign-in gets the name the browser cannot be tricked about", () => {
  const { res, sent } = recorder();
  setSessionCookie(res, "token", true, 3600);
  const cookie = sent[0]!;
  assert.ok(cookie.startsWith(`${HOST_COOKIE}=token;`), cookie);
  // __Host- means exactly this: no Domain, Path=/, HttpOnly, and Secure.
  for (const part of [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
    "Max-Age=3600",
  ]) {
    assert.ok(cookie.includes(part), `${part} missing from ${cookie}`);
  }
  assert.ok(!cookie.includes("Domain="));
});

test("a plain-HTTP sign-in gets a cookie that a liar cannot force", () => {
  const { res, sent } = recorder();
  setSessionCookie(res, "token", false, 3600);
  assert.ok(sent[0]!.startsWith(`${PLAIN_COOKIE}=`), sent[0]);
  assert.ok(!sent[0]!.includes("Secure"), sent[0]!);
});

test("signing out ends both spellings", () => {
  const { res, sent } = recorder();
  clearSessionCookie(res, true);
  assert.equal(sent.length, 2);
  for (const cookie of sent) {
    assert.ok(cookie.includes("Max-Age=0"), cookie);
    assert.ok(cookie.includes("Expires="), cookie);
  }
  assert.deepEqual(
    sent.map((cookie) => cookie.split("=")[0]),
    [HOST_COOKIE, PLAIN_COOKIE],
  );
});

const SESSIONS: Record<string, SessionGrant> = {
  good: { id: "s1", email: "alice@test" },
};

function withStore(
  lookup: (token: string) => Promise<SessionGrant | undefined>,
) {
  configureSessionStore({ lookup });
  return sessionProvider();
}

test("a known cookie is the account, and says which sign-in it is", async () => {
  const provider = withStore(async (token) => SESSIONS[token]);
  const outcome = await resolveIdentity([provider], {
    headers: header(`${PLAIN_COOKIE}=good`),
  });
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.identity, {
    email: "alice@test",
    via: "session",
    sessionId: "s1",
  });
});

test("a cookie that is unknown is refused, and nothing else is asked", async () => {
  const provider = withStore(async (token) => SESSIONS[token]);
  const outcome = await resolveIdentity([provider], {
    headers: header(`${PLAIN_COOKIE}=stolen_or_expired`),
  });
  assert.deepEqual(outcome, { ok: false, reason: "invalid_session" });
});

test("a session is never an agent, whatever it is doing", async () => {
  const provider = withStore(async (token) => SESSIONS[token]);
  const outcome = await resolveIdentity([provider], {
    headers: header(`${PLAIN_COOKIE}=good`, "x-dev-agent: 1"),
  });
  assert.ok(outcome.ok);
  assert.notEqual(outcome.identity.agent, true);
});

test("a sign-in is asked about after Access, and before the dev identity", async () => {
  process.env.DEV_USERS = "1";
  const provider = withStore(async (token) => SESSIONS[token]);
  try {
    // A browser that came through Access is served by Access; the cookie is for
    // deployments with nothing else.
    const both = await resolveIdentity(providers(), {
      headers: {
        "cf-access-jwt-assertion": "not-verifiable",
        cookie: `${PLAIN_COOKIE}=good`,
      },
    });
    assert.deepEqual(both, { ok: false, reason: "invalid_token" });

    const cookie = await resolveIdentity(providers(), {
      headers: header(`${PLAIN_COOKIE}=good`),
    });
    assert.ok(cookie.ok);
    assert.equal(cookie.identity.via, "session");

    // With no such session, the dev identity is still the last resort it was.
    const unknown = await resolveIdentity(providers(), {
      headers: header(`${PLAIN_COOKIE}=nope`, "x-dev-user-email: mallory@test"),
    });
    assert.deepEqual(unknown, { ok: false, reason: "invalid_session" });
  } finally {
    delete process.env.DEV_USERS;
    configureSessionStore(undefined);
  }
});

test("Access assertions are checked unless somebody said not to", () => {
  const saved = process.env.ACCESS_NOT_VERIFIED;
  delete process.env.ACCESS_NOT_VERIFIED;
  try {
    assert.equal(accessAssertionsVerified(), true);
    process.env.ACCESS_NOT_VERIFIED = "1";
    assert.equal(accessAssertionsVerified(), false);
  } finally {
    if (saved === undefined) delete process.env.ACCESS_NOT_VERIFIED;
    else process.env.ACCESS_NOT_VERIFIED = saved;
  }
});
