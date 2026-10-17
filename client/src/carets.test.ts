import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveCursor } from "shared";
import { presenceKey } from "shared";
// The caret logic is pure document math, so the unit suite exercises it
// against fake documents instead of a live ProseMirror view.
import {
  caretAnchor,
  caretColor,
  positionOfText,
  resolveCaretPosition,
  type TextDoc,
} from "./carets.ts";

// A document that is just enough ProseMirror for the caret code: text nodes
// at positions, and a size. Paragraphs cost one position to open and close.
function doc(paragraphs: string[]): TextDoc {
  const nodes: { isText: boolean; text: string; pos: number }[] = [];
  let pos = 1;
  let size = 0;
  for (const text of paragraphs) {
    nodes.push({ isText: true, text, pos });
    pos += text.length + 2;
    size = pos + 1;
  }
  return {
    content: { size },
    descendants(fn) {
      for (const node of nodes) fn(node, node.pos);
    },
  };
}

function caret(position: number | null, anchor = "", version = 1): LiveCursor {
  return { email: "bob@test", position, anchor, version };
}

test("the same version trusts the reported position outright", () => {
  const d = doc(["hello world"]);
  assert.equal(resolveCaretPosition(caret(5, "hell", 2), d, 2), 5);
});

test("a drifted version relocates the caret by its anchor", () => {
  const d = doc(["hello world"]);
  // The anchor is the text the caret sits behind; it lands after "world".
  const found = resolveCaretPosition(caret(999, "world", 1), d, 7);
  assert.equal(found, positionOfText(d, "world"));
  assert.ok(found !== null && found <= d.content.size);
});

test("a caret beyond a shrunk document clamps to its end", () => {
  const d = doc(["gone mostly"]);
  const size = d.content.size;
  assert.equal(
    resolveCaretPosition(caret(size + 500, "never there", 9), d, 3),
    size,
  );
});

test("an out-of-bounds position on a matching version is corrected", () => {
  const d = doc(["short"]);
  const size = d.content.size;
  assert.equal(resolveCaretPosition(caret(size + 9, "", 4), d, 4), size);
});

test("an agent's caret is placed by its anchor, not by its offset", () => {
  // An agent counts characters of markdown, this document counts editor
  // positions, so the two numbers mean different things even at the same version.
  const d = doc(["- buy milk", "- walk the dog"]);
  const agentCaret: LiveCursor = {
    email: "bob@test",
    agent: true,
    position: 24,
    anchor: "walk the dog",
    version: 3,
  };
  const found = resolveCaretPosition(agentCaret, d, 3);
  assert.equal(found, positionOfText(d, "walk the dog"));
  assert.notEqual(found, agentCaret.position);
});

test("an agent's caret with nothing to find clamps to the document", () => {
  const d = doc(["short"]);
  const lost: LiveCursor = {
    email: "bob@test",
    agent: true,
    position: 900,
    anchor: "gone entirely",
    version: 3,
  };
  assert.equal(resolveCaretPosition(lost, d, 3), d.content.size);
});

test("a cleared caret resolves to nothing", () => {
  assert.equal(resolveCaretPosition(caret(null), doc(["x"]), 1), null);
});

test("an anchor and its position round-trip through the document", () => {
  const d = doc(["hello world", "second paragraph"]);
  // For every text position, the anchor taken there must find that position
  // again — as long as the preceding text is unique enough to find.
  const first = d; // positions 1..11 and 14..29ish
  for (let position = 2; position <= 11; position += 1) {
    const anchor = caretAnchor(first, position);
    assert.equal(positionOfText(first, anchor), position, `pos ${position}`);
  }
});

test("an empty anchor finds nothing", () => {
  assert.equal(positionOfText(doc(["anything"]), ""), null);
  assert.equal(positionOfText(doc(["anything"]), "   "), null);
});

test("caretColor is stable per person and varies between people", () => {
  assert.equal(caretColor("bob@test"), caretColor("bob@test"));
  const colors = new Set(
    ["alice@test", "bob@test", "charlie@test"].map(caretColor),
  );
  assert.equal(colors.size, 3);
});

test("a person and their own agent are distinct peers", () => {
  // The whole point of the composite key: an agent acting as an account must
  // not collapse onto that account's own presence.
  assert.notEqual(
    presenceKey("bob@test", true),
    presenceKey("bob@test", false),
  );
  assert.equal(presenceKey("bob@test"), presenceKey("bob@test", false));
  assert.notEqual(
    caretColor(presenceKey("bob@test", true)),
    caretColor(presenceKey("bob@test", false)),
  );
});
