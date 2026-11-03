import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyIdentityProvider, resolveIdentity, type Credentials } from "./auth.js";

// The trusted-reverse-proxy identity: Authelia authenticates a person and Caddy
// copies the email into `Remote-Email`, but a header alone proves nothing, so the
// provider only believes it alongside a secret that never leaves the two servers.

const SECRET = "a-fixed-proxy-secret";

function headers(record: Record<string, string>): Credentials {
  return { headers: record };
}

async function withSecret<T>(
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env.NOTES_PROXY_SECRET;
  if (value === undefined) delete process.env.NOTES_PROXY_SECRET;
  else process.env.NOTES_PROXY_SECRET = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.NOTES_PROXY_SECRET;
    else process.env.NOTES_PROXY_SECRET = previous;
  }
}

test("no secret header passes, so other doors are unaffected", async () => {
  await withSecret(SECRET, async () => {
    const match = await proxyIdentityProvider().match(
      headers({ "remote-email": "someone@example.com" }),
    );
    assert.deepEqual(match, { kind: "pass" });
  });
});

test("a matching secret grants the proxy's email, lowercased", async () => {
  await withSecret(SECRET, async () => {
    const outcome = await resolveIdentity(
      [proxyIdentityProvider()],
      headers({
        "x-notes-proxy-secret": SECRET,
        "remote-email": "  Alice@Example.COM ",
      }),
    );
    assert.deepEqual(outcome, {
      ok: true,
      identity: { email: "alice@example.com", via: "proxy" },
    });
  });
});

test("a wrong secret is refused, never passed to the next provider", async () => {
  await withSecret(SECRET, async () => {
    const match = await proxyIdentityProvider().match(
      headers({ "x-notes-proxy-secret": "not-it", "remote-email": "a@b.c" }),
    );
    assert.deepEqual(match, { kind: "deny", reason: "invalid_proxy" });
  });
});

test("a secret with no identity header is refused", async () => {
  await withSecret(SECRET, async () => {
    const match = await proxyIdentityProvider().match(
      headers({ "x-notes-proxy-secret": SECRET }),
    );
    assert.deepEqual(match, { kind: "deny", reason: "invalid_proxy" });
  });
});

test("a presented secret is refused when the deployment configures none", async () => {
  await withSecret(undefined, async () => {
    const match = await proxyIdentityProvider().match(
      headers({ "x-notes-proxy-secret": SECRET, "remote-email": "a@b.c" }),
    );
    assert.deepEqual(match, { kind: "deny", reason: "invalid_proxy" });
  });
});
