import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedOrigins, corsOptions, trustProxySetting } from "./network.js";

// What the app believes about the network in front of it. Both defaults are the
// ones that fail safe, so the interesting cases are what an operator can say to
// make them say something else — and what they still cannot say.

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const before = { ...process.env };
  // An unset variable has to be deleted rather than assigned: `process.env.X =
  // undefined` leaves the string "undefined" behind, which reads as a setting.
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    run();
  } finally {
    process.env = before;
  }
}

test("no browser but this origin's own may call the API", () => {
  withEnv({ CORS_ALLOW_ORIGINS: undefined }, () => {
    assert.deepEqual(allowedOrigins(), []);
    // The cors module's "none of mine": no Access-Control-Allow-Origin, ever.
    assert.equal(corsOptions().origin, false);
  });
});

test("allowed origins are the ones that were named, and only those", () => {
  withEnv(
    { CORS_ALLOW_ORIGINS: " http://localhost:6274 , https://inspector.test," },
    () => {
      assert.deepEqual(allowedOrigins(), [
        "http://localhost:6274",
        "https://inspector.test",
      ]);
      assert.deepEqual(corsOptions().origin, [
        "http://localhost:6274",
        "https://inspector.test",
      ]);
    },
  );
});

test("credentials never travel cross-origin, whatever else is set", () => {
  // The session cookie is this origin's; a second, cross-site door beside it is
  // not something a working deployment of this app needs.
  withEnv({ CORS_ALLOW_ORIGINS: "https://inspector.test" }, () => {
    assert.equal(corsOptions().credentials, false);
  });
});

test("a streamable-HTTP client can read its session back", () => {
  // Without these the browser hides them, and an MCP client cannot make a second
  // request or resume a message stream.
  assert.deepEqual(corsOptions().exposedHeaders, [
    "mcp-session-id",
    "last-event-id",
  ]);
});

test("nobody is trusted by default", () => {
  withEnv({ TRUST_PROXY: undefined }, () => {
    assert.equal(trustProxySetting(), false);
  });
  for (const off of ["", "false", "0"]) {
    withEnv({ TRUST_PROXY: off }, () => {
      assert.ok(trustProxySetting() === false || trustProxySetting() === 0);
    });
  }
});

test("a proxy is believed by hops, by address, or by name", () => {
  withEnv({ TRUST_PROXY: "1" }, () => {
    assert.equal(trustProxySetting(), 1);
  });
  withEnv({ TRUST_PROXY: "2" }, () => {
    assert.equal(trustProxySetting(), 2);
  });
  withEnv({ TRUST_PROXY: "103.21.244.0/22" }, () => {
    assert.equal(trustProxySetting(), "103.21.244.0/22");
  });
  withEnv({ TRUST_PROXY: "127.0.0.1, 10.0.0.0/8" }, () => {
    assert.deepEqual(trustProxySetting(), ["127.0.0.1", "10.0.0.0/8"]);
  });
  // Naming "any" is possible but has to be said as plainly as it is dangerous.
  withEnv({ TRUST_PROXY: "true" }, () => {
    assert.equal(trustProxySetting(), true);
  });
});
