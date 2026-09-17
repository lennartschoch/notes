import {
  expect,
  test,
  type APIRequestContext,
  type PlaywrightTestArgs,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

const ALICE = { "x-dev-user-email": "push-alice@test" };
const BOB = { "x-dev-user-email": "push-bob@test" };

const CERT_DIR = join(__dirname, ".certs");
// Mirrors the PUSH_COOLDOWN_MS given to the server in playwright.config.ts.
const COOLDOWN_MS = 3000;
const QUIET_MS = 300;

interface Note {
  id: string;
  version: number;
}

interface Delivery {
  authorization?: string;
  bodyLength: number;
  at: number;
}

// The web-push client in the server always speaks HTTPS, so the test push
// endpoint terminates TLS with a throwaway certificate and the server runs
// with NODE_TLS_REJECT_UNAUTHORIZED=0 (see playwright.config.ts).
let receiver: Server;
let endpoint = "";
const deliveries: Delivery[] = [];

test.beforeAll(async () => {
  rmSync(CERT_DIR, { recursive: true, force: true });
  mkdirSync(CERT_DIR, { recursive: true });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(CERT_DIR, "key.pem"),
      "-out",
      join(CERT_DIR, "cert.pem"),
      "-days",
      "2",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  await new Promise<void>((resolve, reject) => {
    receiver = createServer(
      {
        cert: readFileSync(join(CERT_DIR, "cert.pem")),
        key: readFileSync(join(CERT_DIR, "key.pem")),
      },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          deliveries.push({
            authorization: Array.isArray(req.headers.authorization)
              ? req.headers.authorization[0]
              : req.headers.authorization,
            bodyLength: Buffer.concat(chunks).length,
            at: Date.now(),
          });
          res.statusCode = 201;
          res.end();
        });
      },
    );
    receiver.on("error", reject);
    receiver.listen(0, "127.0.0.1", () => {
      const address = receiver.address() as AddressInfo;
      endpoint = `https://127.0.0.1:${address.port}/push`;
      resolve();
    });
  });
});

test.afterAll(async () => {
  await new Promise((resolve) => receiver.close(resolve));
  rmSync(CERT_DIR, { recursive: true, force: true });
});

// web-push encrypts payloads with the subscriber's P-256 key, so the fake
// subscription carries a freshly generated (throwaway) key pair.
function fakeSubscriptionKeys(): { p256dh: string; auth: string } {
  const { publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" }) as {
    x: string;
    y: string;
  };
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  return {
    p256dh: raw.toString("base64url"),
    auth: Buffer.from("0123456789abcdef").toString("base64url"),
  };
}

async function edit(
  api: APIRequestContext,
  id: string,
  content: string,
  version: number,
): Promise<number> {
  const res = await api.put(`/api/notes/${id}`, {
    data: { content, version },
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as Note).version;
}

async function expectNoMoreDeliveries(ms: number): Promise<void> {
  const count = deliveries.length;
  await new Promise((resolve) => setTimeout(resolve, ms));
  expect(deliveries.length).toBe(count);
}

test("push notifications honour quiet period, cooldown and authorship", async ({
  playwright,
  baseURL,
}: PlaywrightTestArgs) => {
  test.setTimeout(60_000);
  const alice = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: ALICE,
  });
  const bob = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: BOB,
  });

  try {
    await test.step("serves the VAPID public key", async () => {
      const res = await alice.get("/api/push/public-key");
      expect(res.ok()).toBeTruthy();
      const { key } = (await res.json()) as { key: string | null };
      expect(key).toBeTruthy();
    });

    await test.step("registers a subscription", async () => {
      const res = await bob.put("/api/push/subscription", {
        data: { endpoint, keys: fakeSubscriptionKeys() },
      });
      expect(res.status()).toBe(204);
    });

    let noteId = "";
    let version = 0;

    await test.step("never notifies for private notes", async () => {
      const created = await alice.post("/api/notes", {
        data: { content: "Push private note" },
      });
      noteId = ((await created.json()) as Note).id;
      version = await edit(alice, noteId, "Push private note edited", 0);
      await expectNoMoreDeliveries(QUIET_MS * 3);
    });

    await test.step("notifies once after the quiet period, skipping the editor", async () => {
      const shared = await alice.patch(`/api/notes/${noteId}`, {
        data: { visibility: "public" },
      });
      expect(shared.ok()).toBeTruthy();
      version = await edit(alice, noteId, "Push public note one", version);
      version = await edit(alice, noteId, "Push public note two", version);
      // The two rapid saves are one editing session: a single notification,
      // sent to bob (who can view the public note) but not to alice herself.
      await expect
        .poll(() => deliveries.length, { timeout: QUIET_MS * 10 })
        .toBe(1);
      expect(deliveries[0].authorization).toMatch(/^vapid /);
      expect(deliveries[0].bodyLength).toBeGreaterThan(0);
    });

    await test.step("drops changes made during the cooldown", async () => {
      const notifiedAt = deliveries[0].at;
      version = await edit(alice, noteId, "Push public note three", version);
      // Quiet has passed but the cooldown has not, so nothing goes out.
      await expectNoMoreDeliveries(COOLDOWN_MS - 800);
      // Crossing the cooldown boundary must not release the dropped change.
      await expectNoMoreDeliveries(1500);
      expect(deliveries.length).toBe(1);
      // A fresh change after the cooldown starts the quiet timer again.
      version = await edit(alice, noteId, "Push public note four", version);
      await expect
        .poll(() => deliveries.length, { timeout: QUIET_MS * 10 })
        .toBe(2);
      expect(deliveries[1].at - notifiedAt).toBeGreaterThanOrEqual(
        COOLDOWN_MS - 100,
      );
    });

    await test.step("does not notify a subscriber about their own edit", async () => {
      // Wait out the cooldown from the previous notification so that only
      // the authorship rule can suppress this edit.
      await new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS + 500));
      version = await edit(bob, noteId, "Push public note by bob", version);
      await expectNoMoreDeliveries(QUIET_MS * 4);
    });

    await test.step("stops notifying after unsubscribing", async () => {
      const res = await bob.delete("/api/push/subscription", {
        data: { endpoint },
      });
      expect(res.status()).toBe(204);
      version = await edit(alice, noteId, "Push public note four", version);
      await expectNoMoreDeliveries(QUIET_MS * 4);
    });
  } finally {
    await alice.dispose();
    await bob.dispose();
  }
});
