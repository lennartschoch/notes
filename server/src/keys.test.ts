import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_KEY_PREFIX } from "./credentials.js";

// The store keeps whatever the file holds, so it is pointed at a scratch directory
// before it is loaded — the same file, the same writes, away from anybody's notes.
const dir = mkdtempSync(join(tmpdir(), "notes-keys-"));
process.env.API_KEYS_DATA_FILE = join(dir, "keys.json");

const {
  API_KEY_NAME_MAX,
  MAX_KEYS_PER_ACCOUNT,
  createKey,
  findKey,
  initKeys,
  keyForSecret,
  keyName,
  listKeys,
  revokeKey,
  touchKey,
} = await import("./keys.js");

await initKeys();

async function mint(account: string, name: string) {
  const result = await createKey(account, name);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("unreachable");
  return result.key;
}

test("a key is a prefixed secret shown once and kept only as a hash", async () => {
  const key = await mint("alice@test", "laptop agent");
  assert.ok(key.secret.startsWith(API_KEY_PREFIX));
  // 24 bytes of randomness after the prefix: enough that nobody guesses one,
  // short enough to paste from a phone.
  assert.equal(key.secret.slice(API_KEY_PREFIX.length).length, 32);

  // The plaintext exists in this response and nowhere else — including the file
  // an attacker who got the volume would read.
  const onDisk = readFileSync(join(dir, "keys.json"), "utf8");
  assert.ok(!onDisk.includes(key.secret));
  assert.match(onDisk, /[0-9a-f]{64}/);

  // What the owner's list carries: enough to recognise a key, not enough to use
  // one.
  const [listed] = listKeys("alice@test");
  assert.equal(listed?.name, "laptop agent");
  assert.equal(listed?.hint, key.secret.slice(-6));
  assert.ok(!("hash" in (listed ?? {})));
  assert.equal(listed?.lastUsedAt, null);
});

test("the store answers for the key a secret is, and for nothing else", async () => {
  const key = await mint("bob@test", "phone");
  const found = await keyForSecret(key.secret);
  assert.equal(found?.id, key.id);
  assert.equal(found?.account, "bob@test");

  assert.equal(await keyForSecret(`${API_KEY_PREFIX}not-a-key`), undefined);
  // Not even a hash of a real key: without the prefix it is not this
  // credential's shape, and the bearer token belongs to somebody else.
  assert.equal(
    await keyForSecret(key.secret.slice(API_KEY_PREFIX.length)),
    undefined,
  );
  assert.equal(await keyForSecret(""), undefined);
});

test("a key acts as its own account, never as another's", async () => {
  const key = await mint("carol@test", "carol's agent");
  assert.equal(listKeys("dave@test").length, 0);
  assert.equal(findKey("dave@test", key.id), undefined);
  // Which is what makes revocation safe to hand to a person: only the owner's
  // revoke can take a key away.
  assert.equal(await revokeKey("dave@test", key.id), false);
  assert.ok(await keyForSecret(key.secret));
  assert.equal(await revokeKey("carol@test", key.id), true);
  assert.equal(await keyForSecret(key.secret), undefined);
});

test("a name is one line, and never empty", () => {
  assert.equal(keyName("  Home\r\nserver  "), "Home server");
  assert.equal(keyName("\t🤖\tagent\tone"), "🤖 agent one");
  assert.equal(keyName("   "), "unnamed key");
  assert.equal(keyName("x".repeat(500)).length, API_KEY_NAME_MAX);
});

test("an account runs out of keys", async () => {
  const account = "many@test";
  for (let i = 0; i < MAX_KEYS_PER_ACCOUNT; i += 1) {
    await mint(account, `key ${i}`);
  }
  assert.equal(listKeys(account).length, MAX_KEYS_PER_ACCOUNT);
  assert.deepEqual(await createKey(account, "one too many"), {
    status: "too_many",
  });
  // Making room is enough: the limit is per account, not global.
  const other = await mint("spare@test", "still fits");
  assert.ok(other.secret.length > 0);
});

test("when a key was last used is kept, for the owner", async () => {
  const key = await mint("erin@test", "watcher");
  assert.equal(listKeys("erin@test")[0]?.lastUsedAt, null);
  await touchKey(key.id);
  const used = listKeys("erin@test")[0]?.lastUsedAt;
  assert.equal(typeof used, "string");
  assert.ok(Date.parse(String(used)) > 0);
  // A key that is gone is not stamped.
  await revokeKey("erin@test", key.id);
  await touchKey(key.id);
});
