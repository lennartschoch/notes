import { test } from "node:test";
import assert from "node:assert/strict";
import { readNote } from "./format.js";
import type { Note } from "../types.js";

function note(content: string, version = 1): Note {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    content,
    owner: "someone@test",
    visibility: "public",
    version,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

test("a read prints numbered lines and the version a write needs", () => {
  const { text } = readNote(note("# Shopping\n\n- buy milk\n"));
  assert.match(text, /v1/);
  assert.match(text, /1 \| # Shopping/);
  assert.match(text, /3 \| - buy milk/);
  assert.match(text, /lines 1-4 of 4/);
  assert.doesNotMatch(text, /more line/);
});

test("a long note says how to get the rest of it", () => {
  const content = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  const { text, caret } = readNote(note(content));
  assert.match(text, /lines 1-80 of 120/);
  assert.match(text, /from: 81/);
  assert.equal(caret, content.split("\n").slice(0, 80).join("\n").length);
});

test("a paged read honours the range and points both ways", () => {
  const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  const { text } = readNote(note(content), { from: 21, lines: 5 });
  assert.match(text, /lines 21-25 of 50/);
  assert.match(text, /lines 1-20 are above/);
  assert.match(text, /from: 26/);
});

test("an empty note reads as empty rather than as a blank line", () => {
  const { text } = readNote(note(""));
  assert.match(text, /empty note/);
});
