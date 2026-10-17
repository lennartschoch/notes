import { test } from "node:test";
import assert from "node:assert/strict";
import type { JWTPayload } from "jose";
import {
  accessAssertion,
  accessProvider,
  devProvider,
  resolveIdentity,
  type Credentials,
  type Provider,
} from "./auth.js";
import {
  API_KEY_PREFIX,
  apiKeyProvider,
  configureApiKeyStore,
  type ApiKeyGrant,
} from "./credentials.js";

// The identity chain, with Access's signature check reduced to a lookup: which
// credential wins, and what a failure is called, is this app's own decision, and
// is worth testing without a token only Cloudflare can sign. The claim mapping for
// machine credentials is a separate matter, tested against real payloads in
// e2e/mcp-identity.spec.ts.

const PERSON: JWTPayload = { email: "Alice@Example.com" };
const SERVICE_TOKEN: JWTPayload = { common_name: "e367826f93b8d7.access" };
const NOBODY: JWTPayload = { sub: "no-email, no known machine" };

// An Access provider that "verifies" exactly the tokens in `signed`.
function access(
  signed: Record<string, JWTPayload>,
  machine?: (payload: JWTPayload) => string,
): Provider {
  return accessProvider({ verify: async (token) => signed[token], machine });
}

function headers(record: Record<string, string>): Credentials {
  return { headers: record };
}

const WITH_TOKEN = {
  assertion: access({ good: PERSON, stale: NOBODY }),
};

test("the assertion is read from Access' header, or from a bearer token", () => {
  assert.equal(
    accessAssertion({ "cf-access-jwt-assertion": " header.token " }),
    "header.token",
  );
  assert.equal(
    accessAssertion({ authorization: "Bearer bearer.token" }),
    "bearer.token",
  );
  // The header wins, and a bearer token that is not one is no credential at all.
  assert.equal(
    accessAssertion({
      "cf-access-jwt-assertion": "header.token",
      authorization: "Bearer bearer.token",
    }),
    "header.token",
  );
  assert.equal(accessAssertion({ authorization: "Basic not-a-token" }), "");
  assert.equal(accessAssertion({}), "");
});

test("a person's token acts as themselves, and never as an agent", async () => {
  const chain = [WITH_TOKEN.assertion];
  const outcome = await resolveIdentity(
    chain,
    headers({ authorization: "Bearer good" }),
  );
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.identity, {
    email: "alice@example.com",
    via: "access",
  });
});

test("a token that does not verify is refused, and nothing else is asked", async () => {
  // The dev header is present and would have worked; a forged credential is not
  // an invitation to look for a softer one.
  const chain = [WITH_TOKEN.assertion, devProvider()];
  const outcome = await resolveIdentity(
    chain,
    headers({
      authorization: "Bearer unknown",
      "x-dev-user-email": "mallory@test",
    }),
  );
  assert.deepEqual(outcome, { ok: false, reason: "invalid_token" });
});

test("a machine token is nobody until the mapping names an account", async () => {
  const credentials = headers({ authorization: "Bearer stale" });
  const unmapped = await resolveIdentity([WITH_TOKEN.assertion], credentials);
  assert.deepEqual(unmapped, { ok: false, reason: "no_account" });

  // Mapped, it is an agent — an account acting under a machine credential, which
  // is a fact about the credential, not a claim inside it.
  const mapped = access({ stale: SERVICE_TOKEN }, () => "agent@example.com");
  const outcome = await resolveIdentity([mapped], credentials);
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.identity, {
    email: "agent@example.com",
    agent: true,
    via: "access",
  });
});

test("no credential is no identity", async () => {
  const outcome = await resolveIdentity(
    [WITH_TOKEN.assertion, devProvider()],
    headers({}),
  );
  assert.deepEqual(outcome, { ok: false, reason: "no_credential" });
});

test("the dev identity is silent unless it was asked for", async () => {
  const without = await resolveIdentity(
    [devProvider()],
    headers({ "x-dev-user-email": "alice@test" }),
  );
  assert.deepEqual(without, { ok: false, reason: "no_credential" });
});

test("under DEV_USERS the dev identity comes from the header, the query, or the default", async () => {
  process.env.DEV_USERS = "1";
  process.env.DEV_USER_EMAIL = "someone@localhost";
  try {
    const chain = [devProvider()];
    const byHeader = await resolveIdentity(
      chain,
      headers({ "x-dev-user-email": " Bob@Test " }),
    );
    assert.ok(byHeader.ok);
    assert.deepEqual(byHeader.identity, { email: "bob@test", via: "dev" });

    // A browser socket cannot set a header, so it may say so in its URL.
    const byQuery = await resolveIdentity(chain, {
      headers: {},
      queryEmail: "carol@test",
    });
    assert.ok(byQuery.ok);
    assert.equal(byQuery.identity.email, "carol@test");

    const byDefault = await resolveIdentity(chain, headers({}));
    assert.ok(byDefault.ok);
    assert.equal(byDefault.identity.email, "someone@localhost");
  } finally {
    delete process.env.DEV_USERS;
    delete process.env.DEV_USER_EMAIL;
  }
});

test("x-dev-agent makes the dev credential a machine, as a service token does", async () => {
  process.env.DEV_USERS = "1";
  try {
    const outcome = await resolveIdentity(
      [devProvider()],
      headers({ "x-dev-user-email": "alice@test", "x-dev-agent": "1" }),
    );
    assert.ok(outcome.ok);
    assert.deepEqual(outcome.identity, {
      email: "alice@test",
      agent: true,
      via: "dev",
    });
  } finally {
    delete process.env.DEV_USERS;
  }
});

test("Access is asked before the dev identity", async () => {
  process.env.DEV_USERS = "1";
  try {
    const chain = [WITH_TOKEN.assertion, devProvider()];
    const outcome = await resolveIdentity(
      chain,
      headers({
        "cf-access-jwt-assertion": "good",
        "x-dev-user-email": "mallory@test",
      }),
    );
    assert.ok(outcome.ok);
    assert.equal(outcome.identity.email, "alice@example.com");
  } finally {
    delete process.env.DEV_USERS;
  }
});

// ---- This app's own machine credential ---------------------------------

const KEY: ApiKeyGrant = { id: "k1", account: "alice@test" };

// A key store that is a lookup, so the chain is tested against the shape of the
// grant rather than against a file. The store itself is keys.test.ts.
// A key store that is a lookup, so the chain is tested against the shape of the
// grant rather than against a file. The store itself is keys.test.ts.
function keyStore(stored: Record<string, ApiKeyGrant>) {
  const used: string[] = [];
  configureApiKeyStore({
    lookup: async (secret) => stored[secret],
    used: async (id) => {
      used.push(id);
    },
  });
  return { provider: apiKeyProvider(), used };
}

test("an API key is its account, driven by a machine", async () => {
  const { provider, used } = keyStore({ [`${API_KEY_PREFIX}good`]: KEY });
  const outcome = await resolveIdentity(
    [provider],
    headers({ authorization: `Bearer ${API_KEY_PREFIX}good` }),
  );
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.identity, {
    email: "alice@test",
    agent: true,
    via: "apikey",
    keyId: "k1",
  });
  // Which key was used is how a revoked key's live sessions are found.
  assert.deepEqual(used, ["k1"]);
});

test("a key that is not in the store grants nobody", async () => {
  // The revoked key, the typo, the one from a different deployment.
  const { provider } = keyStore({});
  const outcome = await resolveIdentity(
    [provider],
    headers({ authorization: `Bearer ${API_KEY_PREFIX}revoked` }),
  );
  assert.deepEqual(outcome, { ok: false, reason: "invalid_key" });
});

test("a key is refused outright when nothing was configured to answer for keys", async () => {
  // Which is how the chain stands before an app hands it a store — and how a
  // deployment turns keys off.
  configureApiKeyStore(undefined);
  const outcome = await resolveIdentity(
    [apiKeyProvider(), devProvider()],
    headers({
      authorization: `Bearer ${API_KEY_PREFIX}good`,
      "x-dev-user-email": "mallory@test",
    }),
  );
  assert.deepEqual(outcome, { ok: false, reason: "invalid_key" });
});

test("neither bearer credential is mistaken for the other", async () => {
  const { provider } = keyStore({ [`${API_KEY_PREFIX}good`]: KEY });
  const chain = [provider, WITH_TOKEN.assertion];

  // A key is not an Access token: it is not three base64url segments, and
  // asking Cloudflare about it would be a pointless round trip.
  const asKey = await resolveIdentity(
    chain,
    headers({ authorization: `Bearer ${API_KEY_PREFIX}good` }),
  );
  assert.ok(asKey.ok);
  assert.equal(asKey.identity.via, "apikey");

  const asAccess = await resolveIdentity(
    chain,
    headers({ authorization: "Bearer good" }),
  );
  assert.ok(asAccess.ok);
  assert.equal(asAccess.identity.via, "access");

  assert.equal(
    accessAssertion({ authorization: `Bearer ${API_KEY_PREFIX}good` }),
    "",
  );
});
