import { test } from "node:test";
import assert from "node:assert/strict";
import { actorLabel, pushBody, type Actor } from "./types.js";

// The wording that tells a person "an agent did this, not them" — owned by the
// server, never by the agent, so a bot cannot rename itself into a person.

test("a real user is labelled by their email; an agent, as the account's agent", () => {
  const person: Actor = { email: "alice@test" };
  const agent: Actor = { email: "alice@test", agent: true };
  assert.equal(actorLabel(person), "alice@test");
  assert.equal(actorLabel(agent), "alice@test\u2019s agent");
});

test("a push body attributes an agent edit and counts the rest", () => {
  assert.equal(
    pushBody([{ email: "alice@test", agent: true }]),
    "Updated by alice@test\u2019s agent",
  );
  assert.equal(pushBody([{ email: "alice@test" }]), "Updated by alice@test");
  assert.equal(
    pushBody([{ email: "alice@test", agent: true }, { email: "bob@test" }]),
    "Updated by alice@test\u2019s agent and 1 other",
  );
  assert.equal(pushBody([]), "Updated by someone");
});
