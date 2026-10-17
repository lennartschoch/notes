import { expect, test } from "@playwright/test";

// What the server says about itself to a browser. The web client is served from
// this very origin, so these headers should be absent unless an operator named
// another one — and an unchecked `Access-Control-Allow-Origin: *` beside the
// session cookie this app is about to grow is not a header worth inheriting.

const OUTSIDE = "https://not-this-origin.test";

test("a page from another origin is answered with no permission at all", async ({
  request,
}) => {
  const read = await request.get("/api/health", {
    headers: { origin: OUTSIDE },
  });
  expect(read.status()).toBe(200);
  expect(read.headers()).not.toHaveProperty("access-control-allow-origin");

  // The preflight that a real cross-site fetch would send first. Refused here
  // means the browser stops before the API is touched at all.
  const preflight = await request.fetch("/api/notes", {
    method: "OPTIONS",
    headers: {
      origin: OUTSIDE,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  expect(preflight.headers()).not.toHaveProperty("access-control-allow-origin");

  const mcp = await request.post("/mcp", {
    headers: { origin: OUTSIDE },
    data: { jsonrpc: "2.0", id: 1, method: "ping" },
  });
  expect(mcp.headers()).not.toHaveProperty("access-control-allow-origin");
});

test("the app's own origin is served as it always was", async ({ request }) => {
  // Same-origin requests carry no `Origin` for GETs and are not what CORS governs;
  // this is the ordinary path every other spec rides on.
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expect((await health.json()).ok).toBe(true);
});
