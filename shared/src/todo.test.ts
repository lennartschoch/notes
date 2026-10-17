import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTodoMarkdown,
  reconcileTodoMarkdown,
  startTodoMarkdown,
  todoDayHeadings,
  todoName,
} from "./todo.js";

// The rules of a rolling to-do list, as the write path applies them. Both the
// server and the web editor run `reconcileTodoMarkdown` on the same text, so
// what matters here is that the rules are pure: the same note and the same day
// always produce the same list, and running them again changes nothing.

const TODAY = "2026-07-07";
const PAST = "2026-07-01";

test("a ticked item is filed under the day it was ticked", () => {
  const filed = reconcileTodoMarkdown(
    `# Todo · Groceries\n\n- [ ] milk\n- [x] eggs\n`,
    TODAY,
  );
  assert.equal(
    filed,
    `# Todo · Groceries\n\n- [ ] milk\n\n## ${TODAY}\n\n- [x] eggs`,
  );
});

test("an agent's tick is a half edit, and filing is the other half", () => {
  // What the MCP tools and the REST API hold after a write that only changed
  // the box: the tick sits in the open list, which is a shape no client shows.
  const ticked = `# Todo · Groceries

- [x] milk
- [ ] eggs
`;
  assert.equal(
    reconcileTodoMarkdown(ticked, TODAY),
    `# Todo · Groceries

- [ ] eggs

## ${TODAY}

- [x] milk`,
  );
});

test("already-filed text is left alone, so both callers can run the rule", () => {
  const filed = reconcileTodoMarkdown(
    `# Todo · Groceries\n\n- [x] eggs\n`,
    TODAY,
  );
  assert.notEqual(filed, null);
  // The editor files on the keystroke and the server files on the write; the
  // second run must not move the item again, nor re-date it.
  assert.equal(reconcileTodoMarkdown(filed!, PAST), null);
  assert.equal(reconcileTodoMarkdown(filed!, TODAY), null);
});

test("reopening an archived item brings it back to the open list", () => {
  const archived = `# Todo · Groceries\n\n- [ ] milk\n\n## ${PAST}\n\n- [ ] eggs`;
  assert.equal(
    reconcileTodoMarkdown(archived, TODAY),
    `# Todo · Groceries\n\n- [ ] eggs\n\n- [ ] milk`,
  );
});

test("a day keeps what it filed, and loses its heading when emptied", () => {
  const archived = `# Todo · Groceries\n\n- [ ] milk\n\n## ${PAST}\n\n- [x] eggs`;
  assert.equal(
    reconcileTodoMarkdown(archived, TODAY),
    null,
    "a checked item in a day heading is already where it belongs",
  );

  const emptied = `# Todo · Groceries\n\n- [ ] milk\n\n## ${PAST}\n\n- [ ] eggs`;
  const reopened = reconcileTodoMarkdown(emptied, TODAY);
  assert.ok(reopened);
  assert.ok(!reopened.includes(PAST), "the empty day heading is dropped");
});

test("the list's name is never rewritten", () => {
  const filed = reconcileTodoMarkdown(
    `# Todo · Groceries, big shop\n\n- [x] eggs\n`,
    TODAY,
  );
  assert.ok(filed?.startsWith("# Todo · Groceries, big shop"));
});

test("an ordinary note is not a to-do list, and is not touched", () => {
  const note = `- [ ] call the bank\n- [x] pay the roof bill\n`;
  assert.ok(!isTodoMarkdown(note));
  assert.equal(reconcileTodoMarkdown(note, TODAY), null);
});

test("launching a note makes its lines the open items", () => {
  assert.equal(
    startTodoMarkdown("- buy milk\n- book the mover", `Groceries`),
    `# Todo · Groceries\n\n- [ ] buy milk\n- [ ] book the mover`,
  );
});

test("an empty list still has an item to type into", () => {
  assert.equal(
    startTodoMarkdown("", "Groceries"),
    `# Todo · Groceries\n\n- [ ] `,
  );
});

test("a list is launched once, and keeps the name it was given", () => {
  const list = `# Todo · Groceries\n\n- [ ] eggs`;
  assert.equal(startTodoMarkdown(list, "Something else"), list);
  assert.equal(todoName(list), "Groceries");
  assert.equal(todoName("# Groceries\n\n- buy milk"), null);
});

test("a name reaches the heading as one line", () => {
  assert.ok(
    startTodoMarkdown("milk", "Groceries\n\ton the way home").startsWith(
      "# Todo · Groceries on the way home\n",
    ),
  );
});

test("the days a list files under are the headings it carries", () => {
  const list =
    `# Todo · House\n\n- [ ] order frames\n\n` +
    `## ${PAST}\n\n- [x] clear the desk\n\n## ${TODAY}\n\n- [x] fix the lamp`;
  assert.deepEqual(todoDayHeadings(list), [PAST, TODAY]);
  assert.deepEqual(todoDayHeadings("# Groceries\n\n## Notes"), []);
});
