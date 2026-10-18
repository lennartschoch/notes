import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_BLOCK_MS,
  MAX_ATTEMPTS,
  attempt,
  failed,
  forgetEverything,
  succeeded,
  sweep,
  watchedCount,
} from "./guard.js";

// Counting guesses. The waits are real seconds, so these tests measure the shape
// of the response rather than sitting through it.
const KEY = "alice@test|203.0.113.7";

test("a first caller is not being watched", () => {
  forgetEverything();
  assert.deepEqual(attempt(KEY), { allowed: true });
  assert.equal(watchedCount(), 0, "and nothing was remembered for asking");
});

test("mistyping is answered as a mistake, not as a threat", () => {
  forgetEverything();
  for (let count = 0; count < MAX_ATTEMPTS - 1; count += 1) {
    assert.deepEqual(failed(KEY), { allowed: true }, `failure ${count + 1}`);
    assert.deepEqual(attempt(KEY), { allowed: true });
  }
});

test("the failure that fills the measure begins the wait", () => {
  forgetEverything();
  for (let count = 0; count < MAX_ATTEMPTS; count += 1) failed(KEY);
  // The wait is already being served on that same request: a right answer sent at
  // the same moment is not a reason to give one.
  const blocked = attempt(KEY);
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) {
    assert.ok(blocked.retryAfterSeconds > 0);
    assert.ok(blocked.retryAfterSeconds <= BASE_BLOCK_MS / 1000);
  }
});

test("keeping at it is answered with more of the same, to a limit", () => {
  forgetEverything();
  const waits: number[] = [];
  for (let count = 0; count < MAX_ATTEMPTS + 8; count += 1) {
    const outcome = failed(KEY);
    if (!outcome.allowed) waits.push(outcome.retryAfterSeconds);
  }
  // Every failure past the limit is met with a wait, and the waits grow.
  assert.ok(waits.length > 1);
  assert.ok(waits[1]! >= waits[0]!);
  assert.ok(waits.at(-1)! <= 15 * 60, "and none of them is a day");
});

test("getting it right wipes the slate", () => {
  forgetEverything();
  for (let count = 0; count < MAX_ATTEMPTS; count += 1) failed(KEY);
  assert.equal(attempt(KEY).allowed, false);
  succeeded(KEY);
  assert.deepEqual(attempt(KEY), { allowed: true });
});

test("guessing at one account does not trouble another", () => {
  forgetEverything();
  for (let count = 0; count < MAX_ATTEMPTS; count += 1) {
    failed(`alice@test|203.0.113.7`);
  }
  assert.equal(attempt("alice@test|198.51.100.4").allowed, true);
  assert.equal(attempt("bob@test|203.0.113.7").allowed, true);
});

test("a trail is forgotten", () => {
  forgetEverything();
  failed(KEY);
  failed("other@test|192.0.2.1");
  assert.equal(watchedCount(), 2);
  assert.equal(sweep(), 0, "nothing has aged out yet");
  forgetEverything();
  assert.equal(watchedCount(), 0);
});
