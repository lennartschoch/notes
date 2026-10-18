import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from "./password.js";

// Password hashing, tested against the things that make a hash store wrong rather
// than against the mathematics inside it.

const PASSWORD = "a person's own long password";

test("a password verifies, and a different one does not", async () => {
  const hash = await hashPassword(PASSWORD);
  assert.equal(await verifyPassword(PASSWORD, hash), true);
  assert.equal(await verifyPassword(`${PASSWORD}x`, hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("two identical passwords are two different hashes", async () => {
  // A shared salt would make a stolen file a list of who uses which password.
  assert.notEqual(await hashPassword(PASSWORD), await hashPassword(PASSWORD));
});

test("the record says how it was made, and is not the password", async () => {
  const hash = await hashPassword(PASSWORD);
  const [scheme, n, r, p, salt, derived] = hash.split("$");
  assert.equal(scheme, "scrypt");
  assert.ok(Number(n) >= 2 ** 14, "expensive enough to slow a guesser down");
  assert.ok(Number(r) >= 8);
  assert.ok(Number(p) >= 1);
  assert.equal(Buffer.from(String(salt), "base64").length, 16);
  assert.equal(Buffer.from(String(derived), "base64").length, 64);
  assert.ok(!hash.includes(PASSWORD));
});

test("a record that is not one is refused, not trusted", async () => {
  for (const junk of [
    "",
    "hunter2",
    "scrypt$2$1$1$AAA=$",
    // The right shape and the wrong lengths, or the wrong numbers.
    `scrypt$2$1$1$${Buffer.alloc(16).toString("base64")}$`,
    `bcrypt$2$1$1$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(64).toString("base64")}`,
    `scrypt$0$1$1$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(64).toString("base64")}`,
    `scrypt$2$1$1$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(8).toString("base64")}`,
    "scrypt$1$2$3$4$5$6$7",
  ]) {
    assert.equal(
      await verifyPassword(PASSWORD, junk),
      false,
      junk.slice(0, 24),
    );
    assert.equal(passwordNeedsRehash(junk), true, junk.slice(0, 24));
  }
});

test("a cheaper hash than this build would write is marked for rewriting", async () => {
  const hash = await hashPassword(PASSWORD);
  assert.equal(passwordNeedsRehash(hash), false);
  const weaker = hash.replace(
    /^scrypt\$(\d+)/,
    (_all, n: string) => `scrypt$${Math.max(2, Number(n) / 2)}`,
  );
  assert.equal(passwordNeedsRehash(weaker), true);
  // …and still verifies, because the parameters travel with it.
  assert.equal(
    await verifyPassword(PASSWORD, weaker),
    false,
    "a different cost is a different hash",
  );
});

test("a password of any kind survives the round trip", async () => {
  for (const value of [
    "☃☃☃☃☃☃☃☃☃☃☃☃☃☃",
    "a".repeat(512),
    "$not$valued$by$splitting",
    "trailing space   ",
  ]) {
    assert.equal(
      await verifyPassword(value, await hashPassword(value)),
      true,
      value.slice(0, 12),
    );
  }
});
