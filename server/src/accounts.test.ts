import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredAccountShape } from "./accounts.js";
import { hashPassword, passwordNeedsRehash } from "./password.js";

// The account store in a scratch directory, so it can be read as it is written
// without anybody's notes being in the way. The path has to be in the environment
// before the module is loaded, which is why this is an import and not one.
const dir = mkdtempSync(join(tmpdir(), "notes-accounts-"));
const FILE = join(dir, "accounts.json");
process.env.ACCOUNTS_DATA_FILE = FILE;
const {
  accountCount,
  accountName,
  createAccount,
  initAccounts,
  isEmail,
  listAccounts,
  normaliseEmail,
  passwordProblem,
  recordSignIn,
  reloadAccounts,
  removeAccount,
  renameAccount,
  setPassword,
  signIn,
  temporaryPassword,
} = await import("./accounts.js");

await initAccounts();

const PASSWORD = "twelve characters or more";

function stored(): StoredAccountShape[] {
  return JSON.parse(readFileSync(FILE, "utf8")) as StoredAccountShape[];
}

// Another process editing the file — which is exactly what the command line is.
function rewrite(
  change: (accounts: StoredAccountShape[]) => void,
): Promise<void> {
  const accounts = stored();
  change(accounts);
  writeFileSync(FILE, JSON.stringify(accounts, null, 2));
  return reloadAccounts();
}

function find(email: string): StoredAccountShape | undefined {
  return stored().find((account) => account.email === email);
}

test("an address is an address, and the same one twice over", () => {
  assert.ok(isEmail("alice@example.com"));
  assert.ok(isEmail("a@b.co"));
  // The shapes that are not accounts, and would make nonsense owners of notes.
  for (const not of [
    "alice",
    "",
    "two@@example.com",
    "a b@example.com",
    'q"t@example.com',
  ]) {
    assert.ok(!isEmail(not), not);
  }
  // Which is what makes the address Access put in a note and the address typed
  // into a login form the same account rather than two.
  assert.equal(normaliseEmail("  ALICE@Example.com "), "alice@example.com");
});

test("a name is one line, whatever was typed into it", () => {
  assert.equal(accountName("  Alice\r\nDoe  "), "Alice Doe");
  assert.equal(accountName("x".repeat(400)).length, 48);
  assert.equal(accountName("   "), "");
});

test("a password is judged on being one", () => {
  assert.equal(passwordProblem(PASSWORD), "");
  assert.match(passwordProblem("short"), /at least 10/);
  assert.match(passwordProblem("x".repeat(600)), /no more than 512/);
  // No composition rules: length is the one thing a person can meet from memory.
  assert.equal(passwordProblem("☃☃☃☃☃☃☃☃☃☃☃☃"), "");
});

test("a made-up password is meant to be read aloud", () => {
  const made = temporaryPassword();
  assert.match(made, /^.{4}-.{4}-.{4}$/, made);
  // Letters and digits that survive being misread over a phone call.
  assert.ok(
    !/[ilo01]/.test(made),
    made,
    "nothing that gets misread over the phone",
  );
  assert.notEqual(temporaryPassword(), temporaryPassword());
});

test("an account is created, and keeps no password", async () => {
  const result = await createAccount(
    "Alice@Example.com",
    PASSWORD,
    " Alice\n Doe ",
  );
  assert.deepEqual(result, {
    status: "ok",
    email: "alice@example.com",
    password: PASSWORD,
  });

  const account = listAccounts().find(
    (entry) => entry.email === "alice@example.com",
  );
  assert.equal(account?.name, "Alice Doe");
  assert.equal(account?.active, true);
  assert.equal(account?.createdBy, "cli");
  assert.deepEqual(account?.usage, { signedInAt: null, signedInFrom: null });
  assert.ok(!("hash" in (account ?? {})), "the list carries no hash");

  const onDisk = readFileSync(FILE, "utf8");
  assert.ok(!onDisk.includes(PASSWORD), "the password itself is never stored");
  assert.match(onDisk, /scrypt\$/);
});

test("signing in knows its account, and says nothing more", async () => {
  assert.deepEqual(await signIn("alice@example.com", PASSWORD), {
    status: "ok",
    email: "alice@example.com",
  });
  // One answer for "wrong" and for "nobody here by that name".
  assert.deepEqual(await signIn("alice@example.com", "not the password"), {
    status: "denied",
  });
  assert.deepEqual(await signIn("nobody@example.com", PASSWORD), {
    status: "denied",
  });
  assert.equal((await signIn(" ALICE@example.COM ", PASSWORD)).status, "ok");
});

test("an account is not made twice, or half-made", async () => {
  assert.deepEqual(await createAccount("alice@example.com", PASSWORD), {
    status: "exists",
  });
  assert.equal((await createAccount("bob@example.com", "tiny")).status, "weak");
  assert.equal(accountCount(), 1, "nothing half-made was left behind");
  await assert.rejects(
    () => createAccount("nope", PASSWORD),
    /not an email address/,
  );
});

test("a password is replaced for one account only", async () => {
  await createAccount("carol@example.com", PASSWORD);

  assert.equal(
    await setPassword("alice@example.com", "a second long password"),
    true,
  );
  assert.equal((await signIn("alice@example.com", PASSWORD)).status, "denied");
  assert.equal(
    (await signIn("alice@example.com", "a second long password")).status,
    "ok",
  );
  assert.equal((await signIn("carol@example.com", PASSWORD)).status, "ok");

  assert.equal(
    await setPassword("nobody@example.com", "another long one"),
    false,
  );
  assert.equal(await setPassword("alice@example.com", "tiny"), false);
  await setPassword("alice@example.com", PASSWORD);
});

test("a hash from an older build still opens the door, then improves itself", async () => {
  await createAccount("old@example.com", PASSWORD);
  // A record as an older build would have written it: fewer rounds, with the cost
  // stored alongside the hash rather than assumed by whoever reads it next.
  const cheaper = await hashPassword(PASSWORD, { N: 2048, r: 8, p: 1 });
  await rewrite((accounts) => {
    const entry = accounts.find(
      (account) => account.email === "old@example.com",
    );
    if (entry) entry.hash = cheaper;
  });

  assert.ok(passwordNeedsRehash(String(find("old@example.com")?.hash)));
  assert.equal((await signIn("old@example.com", PASSWORD)).status, "ok");
  const improved = String(find("old@example.com")?.hash);
  assert.notEqual(
    improved,
    cheaper,
    "and it was rewritten at this cost, on the way past",
  );
  assert.ok(!passwordNeedsRehash(improved));
});

test("a hash that is not a hash opens nothing", async () => {
  await createAccount("broken@example.com", PASSWORD);
  await rewrite((accounts) => {
    const entry = accounts.find(
      (account) => account.email === "broken@example.com",
    );
    if (entry) entry.hash = "hunter2";
  });
  assert.equal(
    (await signIn("broken@example.com", "hunter2")).status,
    "denied",
  );
  assert.equal((await signIn("broken@example.com", PASSWORD)).status, "denied");
});

test("an account that is not active knows the password and still gets nothing", async () => {
  await createAccount("dave@example.com", PASSWORD);
  await rewrite((accounts) => {
    const entry = accounts.find(
      (account) => account.email === "dave@example.com",
    );
    if (entry) entry.active = false;
  });
  // Named rather than hidden: only someone holding the correct password learns it,
  // and their remedy is different.
  assert.deepEqual(await signIn("dave@example.com", PASSWORD), {
    status: "inactive",
  });
  assert.deepEqual(await signIn("dave@example.com", "wrong password"), {
    status: "denied",
  });
});

test("where an account was last used", async () => {
  await recordSignIn("alice@example.com", "203.0.113.7");
  const account = listAccounts().find(
    (entry) => entry.email === "alice@example.com",
  );
  assert.equal(account?.usage.signedInFrom, "203.0.113.7");
  assert.ok(account?.usage.signedInAt);
  assert.ok(Date.parse(String(account?.usage.signedInAt)) > 0);
  // An account that is not here is not recorded as having been.
  await recordSignIn("nobody@example.com", "203.0.113.7");
});

test("a name is the account's, and so is its removal", async () => {
  assert.equal(
    await renameAccount("alice@example.com", "  Alice  the Second "),
    true,
  );
  assert.equal(
    listAccounts().find((entry) => entry.email === "alice@example.com")?.name,
    "Alice the Second",
  );
  assert.equal(await renameAccount("nobody@example.com", "who"), false);

  assert.deepEqual(await removeAccount("old@example.com"), {
    status: "removed",
  });
  assert.deepEqual(await removeAccount("old@example.com"), {
    status: "not_found",
  });
  assert.equal((await signIn("old@example.com", PASSWORD)).status, "denied");
  assert.equal((await signIn("carol@example.com", PASSWORD)).status, "ok");
});

test("a record that cannot be read is dropped, and says so", async () => {
  const keep = stored();
  writeFileSync(
    FILE,
    JSON.stringify(
      [
        ...keep,
        { email: "nonsense", hash: "x" },
        { hash: await hashPassword("y") },
      ],
      null,
      2,
    ),
  );
  await reloadAccounts();
  // No half-account: an owner is an address, and there is none to invent.
  assert.ok(!listAccounts().some((account) => account.email === ""));
  assert.equal(listAccounts().length, keep.length);
});
