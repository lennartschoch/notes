import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorFromText } from "shared";
// The cursor and typing maths is plain text in, plain text out, so it is worth
// testing without a note, a socket, or an MCP client in sight.
import {
  lineEnd,
  noteView,
  pageStart,
  relocateCaret,
  resolveCaret,
  defuseLinks,
  isLinkUrl,
  linkMarkdown,
  typeText,
} from "./text.js";

// ---- Addressing a caret ---------------------------------------------

const NOTE = "# Shopping\n\n- buy milk\n- walk the dog\n";

test("text addresses the caret from either side", () => {
  const after = resolveCaret(NOTE, { text: "buy milk", side: "after" });
  assert.ok(after.ok);
  assert.equal(after.caret, NOTE.indexOf("buy milk") + "buy milk".length);
  const before = resolveCaret(NOTE, { text: "walk", side: "before" });
  assert.ok(before.ok);
  assert.equal(before.caret, NOTE.indexOf("walk"));
});

test("side defaults to after, which is where typing goes", () => {
  const after = resolveCaret(NOTE, { text: "the dog" });
  assert.ok(after.ok);
  assert.equal(after.caret, NOTE.length - 1);
});

test("words copied with the wrong spacing still land in the right place", () => {
  const content = "# Goals\n\nShip   the\nthing today";
  const found = resolveCaret(content, { text: "ship the thing" });
  assert.ok(found.ok);
  // The caret goes past the words the note really has, not the ones asked for.
  assert.equal(found.caret, content.length - " today".length);
});

test("an ambiguous snippet is refused, with the lines it matched", () => {
  const content = "milk\nbread\nmilk\n";
  const found = resolveCaret(content, { text: "milk" });
  assert.ok(!found.ok);
  assert.match(found.reason, /matches 2 times/);
  assert.match(found.reason, /line 1, line 3/);
});

test("text that is not there says so, and what to do instead", () => {
  const found = resolveCaret(NOTE, { text: "gasoline" });
  assert.ok(!found.ok);
  assert.match(found.reason, /read_note/i);
});

test("line and column address the numbered lines read_note prints", () => {
  const found = resolveCaret(NOTE, { line: 3, column: 3 });
  assert.ok(found.ok);
  assert.equal(found.caret, NOTE.indexOf("- buy milk") + 2);
  // Without a column, a line starts at its first character.
  const start = resolveCaret(NOTE, { line: 3 });
  assert.ok(start.ok);
  assert.equal(start.caret, NOTE.indexOf("- buy milk"));
});

test("an out-of-range line says how many lines there are", () => {
  const found = resolveCaret(NOTE, { line: 99 });
  assert.ok(!found.ok);
  assert.match(found.reason, /has 5 line/);
});

test("an offset is clamped to the note, never past it", () => {
  const found = resolveCaret(NOTE, { offset: 10_000 });
  assert.ok(found.ok);
  assert.equal(found.caret, NOTE.length);
  const negative = resolveCaret(NOTE, { offset: -4 });
  assert.ok(!negative.ok);
});

test("no address at all is a refusal, not position zero", () => {
  const found = resolveCaret(NOTE, {});
  assert.ok(!found.ok);
  assert.match(found.reason, /no position/i);
});

// ---- Following a caret as the note moves ----------------------------

test("a caret is followed along when somebody else types above it", () => {
  const content = "- buy milk\n- walk the dog";
  const anchor = { position: 20, anchor: anchorFromText(content, 20) };
  // A line inserted above the caret shifts it; the words it sits behind do not.
  const moved = `- one hour of piano\n${content}`;
  assert.equal(
    relocateCaret(moved, anchor),
    anchor.position + "- one hour of piano\n".length,
  );
});

test("a caret in text that was deleted falls back to where it was", () => {
  const content = "- buy milk\n- walk the dog";
  const anchor = { position: 20, anchor: anchorFromText(content, 20) };
  assert.equal(relocateCaret("", anchor), 0);
});

// ---- Keystrokes ------------------------------------------------------

test("typing inserts at the caret and leaves it after the words", () => {
  const content = "# Title";
  const typed = typeText(content, content.length, " written by an agent");
  assert.equal(typed.content, "# Title written by an agent");
  assert.equal(typed.caret, "# Title written by an agent".length);
  assert.equal(typed.typed, " written by an agent");
});

test("Enter in prose starts a new paragraph, which markdown spells with a blank line", () => {
  const content = "one sentence\n";
  const typed = typeText(content, "one sentence".length, "\ntwo sentences");
  assert.equal(typed.content, "one sentence\n\ntwo sentences\n");
});

test("Enter in a list makes the next item, with the same marker", () => {
  const content = "- buy milk\n- walk the dog\n";
  const typed = typeText(
    content,
    content.indexOf("milk") + 4,
    "\nfeed the fish",
  );
  assert.equal(typed.content, "- buy milk\n- feed the fish\n- walk the dog\n");
});

test("Enter on an empty item leaves the list, as a person ends it", () => {
  const content = "- buy milk\n- \n";
  const typed = typeText(content, content.indexOf("- \n") + 2, "\n");
  assert.equal(typed.content, "- buy milk\n\n");
});

test("a to-do item's next item starts unticked", () => {
  const content = "- [x] buy milk\n";
  const typed = typeText(content, content.length - 1, "\nmop the floor");
  assert.equal(typed.content, "- [x] buy milk\n- [ ] mop the floor\n");
});

test("a nested or numbered item keeps its indentation and its marker", () => {
  // Markdown numbers every item "1." and lets the renderer count, so this is what
  // the editor writes too.
  const content = "  1. first\n";
  const typed = typeText(content, content.length - 1, "\nsecond");
  assert.equal(typed.content, "  1. first\n  1. second\n");
});

test("Enter in a quote stays in the quote", () => {
  const content = "> quoted words\n";
  const typed = typeText(content, content.length - 1, "\nmore quoted");
  assert.equal(typed.content, "> quoted words\n> more quoted\n");
});

test("backspace deletes backwards, like it does on a keyboard", () => {
  // Backspacing over a letter that should not have been typed, which is the kind
  // of edit an agent makes when it notices what it just did.
  const typed = typeText("worlld", "worll".length, "\b");
  assert.equal(typed.content, "world");
  assert.equal(typed.caret, "world".length - 1);
});

test("a backspace at the start of a note has nowhere to go", () => {
  const typed = typeText("abc", 0, "\b");
  assert.equal(typed.content, "abc");
  assert.equal(typed.caret, 0);
});

test("a word is spaced from the word it follows", () => {
  const content = "buy milk";
  const typed = typeText(content, content.length, "today", { word: true });
  assert.equal(typed.content, "buy milk today");

  // With the space already there, typing one is not two spaces.
  assert.equal(
    typeText("buy milk ", 9, "today", { word: true }).content,
    "buy milk today",
  );
});

test("overwriting a word replaces the one under the caret", () => {
  const content = "buy milk today";
  const typed = typeText(content, content.length, "bread", {
    word: true,
    overwrite: "word",
  });
  assert.equal(typed.content, "buy milk bread");
});

test("overwriting a line replaces the whole thing", () => {
  const content = "# Title\n- stale line\n";
  const typed = typeText(content, content.indexOf("stale") + 3, "fresh line", {
    overwrite: "line",
  });
  assert.equal(typed.content, "# Title\nfresh line\n");
});

// ---- What the agent is shown ----------------------------------------

test("a note is printed as numbered lines", () => {
  const { view, first, last, total } = noteView("a\nb\nc", {});
  assert.equal(view, "1 | a\n2 | b\n3 | c");
  assert.deepEqual({ first, last, total }, { first: 1, last: 3, total: 3 });
});

test("the caret is drawn between two characters of its own line", () => {
  // Offset 9 is the gap in front of "milk" - the place "today" would be typed.
  const { view, place } = noteView("keep the milk", { caret: 9, window: 0 });
  assert.equal(view, "1 | keep the |milk");
  assert.deepEqual(place, { line: 1, column: 10, lineText: "keep the milk" });
});

test("a window shows the lines around the caret and nothing else", () => {
  const { view, first, last } = noteView("1\n2\n3\n4\n5\n6", {
    caret: 4,
    window: 1,
  });
  assert.equal(first, 2);
  assert.equal(last, 4);
  assert.match(view, /^2 \|/);
});

test("lineEnd is where a reader that got that far stands", () => {
  assert.equal(lineEnd("abc\ndefg\nhi", 2), "abc\ndefg".length);
  assert.equal(lineEnd("abc\ndefg\nhi", 99), "abc\ndefg\nhi".length);
});

test("a page of reading is centred on where the reader stands", () => {
  const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  const caret = lineEnd(content, 60);
  const start = pageStart(content, caret, 20);
  assert.ok(start < 60 && start + 20 > 60);
  assert.equal(pageStart(content, null, 20), 1);
});

// ---- Text the agent was handed --------------------------------------

test("a link in text the agent was handed says where it goes", () => {
  assert.equal(
    defuseLinks("click [here](http://not-the-notes.app) now"),
    "click here (http://not-the-notes.app) now",
  );
  // A label that already is the address needs no second copy of it.
  assert.equal(
    defuseLinks(
      "see <https://example.com> and [https://example.com](https://example.com)",
    ),
    "see https://example.com and https://example.com",
  );
  // Words with nothing after them are just words.
  assert.equal(
    defuseLinks("[brackets] and [not] a link"),
    "[brackets] and [not] a link",
  );
});

test("a link needs a real address", () => {
  assert.ok(isLinkUrl("https://example.com/x"));
  assert.ok(isLinkUrl("mailto:someone@example.com"));
  assert.ok(!isLinkUrl("javascript:alert(1)"));
  assert.ok(!isLinkUrl("example.com"));
});

test("a link is written the way the editor writes it", () => {
  assert.equal(
    linkMarkdown("https://example.com", "the notes app"),
    "[the notes app](https://example.com)",
  );
  assert.equal(
    linkMarkdown("https://example.com"),
    "[https://example.com](https://example.com)",
  );
});

// ---- The anchor an editor finds the caret by ------------------------

test("an anchor is the text just before the caret, on its own line", () => {
  const content = "a long line about milk\nsecond line here";
  const caret = content.indexOf("milk") + 4;
  assert.equal(
    anchorFromText(content, caret),
    "a long line about milk".slice(-24),
  );
});

test("a caret at the start of a line anchors on the line above", () => {
  const content = "first line\nsecond line";
  assert.equal(
    anchorFromText(content, content.indexOf("second")),
    "first line",
  );
});

test("an anchor never reaches across a line break", () => {
  const content = "one\ntwo\nthree four five six seven";
  const caret = content.length - 5;
  assert.ok(!anchorFromText(content, caret).includes("\n"));
});
