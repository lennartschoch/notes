import { test } from "node:test";
import assert from "node:assert/strict";
// The merge runs on the server, but it is pure text logic in the shared
// workspace, so the unit suite exercises it straight from source.
import { merge3 } from "../../shared/src/merge.ts";

test("merges edits to different lines of the same note", () => {
  const base = "line one\nline two\nline three\nline four";
  const mine = "line one edited by me\nline two\nline three\nline four";
  const theirs = "line one\nline two\nline three\nline four edited by them";

  const result = merge3(base, mine, theirs);
  assert.equal(result.status, "merged");
  assert.equal(
    (result as { content: string }).content,
    "line one edited by me\nline two\nline three\nline four edited by them",
  );
});

test("keeps both sides when each side only added lines", () => {
  const base = "middle";
  const mine = "top\nmiddle";
  const theirs = "middle\nbottom";

  const result = merge3(base, mine, theirs);
  assert.equal(result.status, "merged");
  assert.equal((result as { content: string }).content, "top\nmiddle\nbottom");
});

test("takes the changed side when only one side changed", () => {
  const base = "a\nb\nc";
  const result = merge3(base, "a\nb\nc", "a\nB\nc");
  assert.deepEqual(result, { status: "merged", content: "a\nB\nc" });

  const otherSide = merge3(base, "a\nX\nc", "a\nb\nc");
  assert.deepEqual(otherSide, { status: "merged", content: "a\nX\nc" });
});

test("keeps identical edits from both sides once", () => {
  const base = "a\nb\nc";
  const result = merge3(base, "a\nb2\nc", "a\nb2\nc");
  assert.deepEqual(result, { status: "merged", content: "a\nb2\nc" });
});

test("a deletion on one side survives an edit elsewhere on the other", () => {
  const base = "keep\ndrop\nanchor\nkeep too";
  const result = merge3(
    base,
    "keep\ndrop\nanchor\nkeep too edited",
    "keep\nanchor\nkeep too",
  );
  assert.deepEqual(result, {
    status: "merged",
    content: "keep\nanchor\nkeep too edited",
  });
});

test("two different edits to the same line are a real conflict", () => {
  const base = "a\nb\nc";
  const result = merge3(base, "a\nmine\nc", "a\ntheirs\nc");
  assert.deepEqual(result, { status: "conflict", reason: "overlap" });
});

test("different insertions on opposite sides of an anchor merge", () => {
  const result = merge3("middle", "top\nmiddle", "middle\nbottom-ish");
  // The insertions land on either side of the same anchor, so each becomes
  // its own region.
  assert.deepEqual(result, {
    status: "merged",
    content: "top\nmiddle\nbottom-ish",
  });
});

test("different insertions at the very same spot are a real conflict", () => {
  const result = merge3("middle", "top\nmiddle", "above\nmiddle");
  assert.deepEqual(result, { status: "conflict", reason: "overlap" });
});

test("rewrites that overlap the same lines conflict", () => {
  const base = "a\nb\nc\nd\ne";
  // Both sides rewrote the middle with nothing unchanged in between.
  const result = merge3(base, "a\nB\nc\nd\ne", "a\nb\nC\nD\ne");
  assert.deepEqual(result, { status: "conflict", reason: "overlap" });
});

test("merges notes with trailing newline and empty content", () => {
  assert.deepEqual(merge3("", "hello", ""), {
    status: "merged",
    content: "hello",
  });
  assert.deepEqual(merge3("", "hello", "hi"), {
    status: "conflict",
    reason: "overlap",
  });
  assert.deepEqual(merge3("", "", ""), { status: "merged", content: "" });
});
