import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StoredSessionShape } from "./sessions.js";

// Sessions live in a scratch file, so expiry and revocation can be inspected as
// written rather than as remembered. The path has to be set before the module is
// loaded, which is why this store is imported rather than one.
const dir = mkdtempSync(join(tmpdir(), "notes-sessions-"));
const FILE = join(dir, "sessions.json");
process.env.SESSIONS_DATA_FILE = FILE;
const {
  createSession,
  describeDevice,
  initSessions,
  listSessions,
  reloadSessions,
  revokeSession,
  revokeSessions,
  sessionForToken,
  sessionLifetimeMs,
  sweepSessions,
} = await import("./sessions.js");

await initSessions();

const HOUR = 60 * 60 * 1000;

function stored(): StoredSessionShape[] {
  return JSON.parse(readFileSync(FILE, "utf8")) as StoredSessionShape[];
}

function rewrite(
  change: (sessions: StoredSessionShape[]) => void,
): Promise<void> {
  const sessions = stored();
  change(sessions);
  writeFileSync(FILE, JSON.stringify(sessions, null, 2));
  return reloadSessions();
}

test("a sign-in is a token to the browser and a hash to the disk", async () => {
  const { session, token } = await createSession(
    "alice@test",
    "Chrome 130 on Linux",
  );
  assert.equal(token.length, 43, "24 bytes of randomness, base64url");
  assert.equal(session.email, "alice@test");
  assert.equal(session.device, "Chrome 130 on Linux");

  const found = await sessionForToken(token);
  assert.equal(found?.id, session.id);
  assert.equal(found?.email, "alice@test");
  assert.ok(!("hash" in (found ?? {})));

  const onDisk = readFileSync(FILE, "utf8");
  assert.ok(!onDisk.includes(token), "the token itself is not kept");
  assert.match(onDisk, /[0-9a-f]{64}/);
});

test("a token that is not one of ours gets nothing", async () => {
  assert.equal(await sessionForToken("whatever"), undefined);
  assert.equal(await sessionForToken(""), undefined);
});

test("the same browser signing in again is one sign-in, not two", async () => {
  await createSession("dupe@test", "Safari 18 on macOS");
  await createSession("dupe@test", "Safari 18 on macOS");
  assert.equal(listSessions("dupe@test").length, 1);
  // A different browser is a different device, and is listed as such.
  await createSession("dupe@test", "Firefox 130 on Linux");
  assert.equal(listSessions("dupe@test").length, 2);
});

test("a sign-in is ended, singly and together", async () => {
  const first = await createSession("bob@test", "Phone browser");
  const second = await createSession("bob@test", "Laptop browser");

  assert.equal(await revokeSession("bob@test", first.session.id), true);
  assert.equal(await revokeSession("bob@test", first.session.id), false);
  assert.equal(await sessionForToken(first.token), undefined);
  assert.ok(await sessionForToken(second.token));

  await createSession("bob@test", "Tablet browser");
  const ended = await revokeSessions("bob@test");
  assert.equal(ended, 2, "both of them, the caller's own included");
  assert.equal(listSessions("bob@test").length, 0);
  assert.equal(await sessionForToken(second.token), undefined);
});

test("revoking one account leaves the others alone", async () => {
  const mine = await createSession("carol@test", "One laptop");
  const theirs = await createSession("dave@test", "Another laptop");
  await revokeSessions("carol@test");
  assert.ok(await sessionForToken(theirs.token));
  assert.equal(await sessionForToken(mine.token), undefined);
});

test("an expired sign-in is no sign-in, and does not stay on the disk", async () => {
  const { session, token } = await createSession("erin@test", "Old browser");
  await rewrite((sessions) => {
    const entry = sessions.find((candidate) => candidate.id === session.id);
    if (entry) entry.expiresAt = new Date(Date.now() - 1000).toISOString();
  });

  assert.equal(await sessionForToken(token), undefined);
  assert.equal(
    stored().some((entry) => entry.id === session.id),
    false,
    "and it was taken out of the file on the way past",
  );
});

test("a sign-in in use is not the same length as one left alone", async () => {
  const { session, token } = await createSession("moz@test", "Busy browser");
  const written = String(
    stored().find((entry) => entry.id === session.id)?.expiresAt ?? "",
  );

  // Two thirds through its life: past the halfway mark, so using it starts it again.
  await rewrite((sessions) => {
    const entry = sessions.find((candidate) => candidate.id === session.id);
    if (entry)
      entry.expiresAt = new Date(
        Date.now() + sessionLifetimeMs / 3,
      ).toISOString();
  });
  const used = await sessionForToken(token);
  assert.ok(used);
  const renewed = String(
    stored().find((entry) => entry.id === session.id)?.expiresAt ?? "",
  );
  assert.ok(renewed >= written, `${renewed} vs ${written}`);
  assert.ok(
    Date.parse(renewed) - Date.now() > sessionLifetimeMs * 0.9,
    "and the whole life again, not the remainder",
  );
  void used;

  // A session with most of its life left is not rewritten for the sake of it.
  const before = readFileSync(FILE, "utf8");
  await sessionForToken(token);
  assert.equal(readFileSync(FILE, "utf8"), before);
});

test("the sweep takes out what ran out while the server was up", async () => {
  // Sessions that had already expired when the file was read are gone at the read,
  // so this is the other case: a sign-in that ran out mid-flight. Sweeping is asked
  // to pretend the clock has moved, which is the only way to reach it on a Sunday.
  await createSession("swept@test", "Dead browser");
  const kept = await createSession("live@test", "Living browser");
  const future = Date.now() + sessionLifetimeMs + HOUR;
  await rewrite((sessions) => {
    const entry = sessions.find(
      (candidate) =>
        candidate.email === "live@test" && candidate.id === kept.session.id,
    );
    // The one that survives: rewritten well past the moment being swept as.
    if (entry)
      entry.expiresAt = new Date(future + 30 * 24 * HOUR).toISOString();
  });

  // Other specs' sign-ins are in this file too, and all of them are older than the
  // moment being swept as — so what is worth asserting is which one was left.
  const before = stored().length;
  assert.equal(await sweepSessions(future), before - 1);
  assert.equal(stored().length, 1);
  assert.equal(stored()[0]?.email, "live@test");
});

test("a device is described in the words a person would use", () => {
  assert.equal(
    describeDevice("  Mozilla/5.0 \r\n (X11; Linux)  "),
    "Mozilla/5.0 (X11; Linux)",
  );
  assert.equal(describeDevice(""), "");
  assert.equal(describeDevice("x".repeat(400)).length, 120);
});
