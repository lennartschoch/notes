// Rolling to-do lists.
//
// A to-do note is plain markdown with one shape:
//
//   # Todo · Groceries
//
//   - [ ] water the plants
//
//   ## 2026-07-07
//
//   - [x] renew passport
//
// Three things are split across that shape, and keeping them apart is what the
// module is about:
//
//   marker   the `Todo` word in the level-1 heading opts the note in, and is
//            the only thing that makes a note a to-do list
//   name     whatever follows `Todo · ` belongs to the user; nothing here
//            writes to it, so a list can be renamed without breaking it
//   days     the level-2 headings, newest first, each holding the items that
//            were ticked on that day
//
// The day the list is being worked on is deliberately not stored: it is
// whatever the clock says when something is ticked, and the newest day heading
// below the title is where it lands. Ticking an item therefore leaves the name
// alone and files the item under today; unticking an archived item takes it
// back out of the day it was filed under.
//
// Everything here is pure string work on the markdown the editor serialises, so
// the rules of the list can be reasoned about without a live editor.

/** Title of a list that was launched without a name. */
export const DEFAULT_TODO_NAME = "My to-dos";

const TITLE_RE = /^#\s+Todo\s*(?:·\s*(.*))?$/;
const DAY_RE = /^##\s+(\d{4}-\d{2}-\d{2})$/;
const TASK_RE = /^([-*+]|\d+\.)\s+\[([ xX])\]/;
const LIST_PREFIX_RE = /^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s*)?/;

/** Local ISO date (YYYY-MM-DD); used as the heading and as an archive key. */
export function todoDate(date = new Date()): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The user's name for the list, read out of its title line. */
function nameOf(titleLine: string): string {
  return (titleLine.trim().match(TITLE_RE)?.[1] ?? "").trim();
}

export function todoHeading(name: string): string {
  return name === "" ? "# Todo" : `# Todo · ${name}`;
}

export function isTodoMarkdown(markdown: string): boolean {
  return markdown.split("\n").some((line) => TITLE_RE.test(line.trim()));
}

function dateOf(line: string, pattern: RegExp): string | null {
  const match = line.trim().match(pattern);
  return match ? match[1] : null;
}

/** Checkbox state of a top-level task line, or null when it is not one. */
function taskState(line: string): "checked" | "unchecked" | null {
  const match = line.match(TASK_RE);
  if (!match) return null;
  return match[2] === " " ? "unchecked" : "checked";
}

/**
 * Source lines that belong together: one list item plus any indented
 * continuation lines. `blankBefore` remembers the blank line that separated the
 * block in the source so the note keeps its spacing when it is rewritten.
 */
interface Block {
  lines: string[];
  blankBefore: boolean;
}

// A moved item joins a different list, so it arrives without the blank line it
// was separated by before.
function tight(block: Block): Block {
  return { ...block, blankBefore: false };
}

interface Section {
  /** Day this section archives, or null for the open list. */
  date: string | null;
  blocks: Block[];
}

interface TodoDoc {
  /** The user's name for the list; null when the note has not opted in. */
  name: string | null;
  open: Section;
  days: Section[];
}

const byDateDesc = (a: Section, b: Section) => (a.date! < b.date! ? 1 : -1);

/**
 * Read a note as a to-do list whether or not it is one: without a title, the
 * whole note is the open list and `name` comes back null.
 */
function parseBody(markdown: string): TodoDoc {
  const lines = markdown.split("\n");
  const titleAt = lines.findIndex((line) => TITLE_RE.test(line.trim()));
  const name = titleAt === -1 ? null : nameOf(lines[titleAt]);

  const open: Section = { date: null, blocks: [] };
  const days: Section[] = [];
  let current = open;

  let buffer: string[] = [];
  let blankBefore = true;
  let pendingBlank = false;

  const flush = () => {
    if (buffer.length === 0) return;
    current.blocks.push({ lines: buffer, blankBefore });
    buffer = [];
  };

  for (const line of lines.slice(titleAt + 1)) {
    const day = line.startsWith("#") ? dateOf(line, DAY_RE) : null;
    if (day) {
      flush();
      current = { date: day, blocks: [] };
      days.push(current);
      blankBefore = pendingBlank;
      pendingBlank = false;
      continue;
    }
    if (line.trim() === "") {
      flush();
      pendingBlank = true;
      continue;
    }
    // An indented line continues the item above it.
    if (buffer.length > 0 && /^\s/.test(line)) {
      buffer.push(line);
      continue;
    }
    flush();
    blankBefore = pendingBlank;
    pendingBlank = false;
    buffer = [line];
  }
  flush();

  return { name, open, days };
}

function parseTodo(markdown: string): TodoDoc | null {
  const doc = parseBody(markdown);
  return doc.name === null ? null : doc;
}

function serialize(doc: TodoDoc): string {
  const output: string[] = [todoHeading(doc.name ?? "")];

  const push = (lines: string[], blankBefore: boolean) => {
    const last = output[output.length - 1];
    if (blankBefore && last !== undefined && last.trim() !== "") {
      output.push("");
    }
    output.push(...lines);
  };

  for (const section of [doc.open, ...doc.days]) {
    if (section.blocks.length === 0) continue;
    if (section.date !== null) push([`## ${section.date}`], true);
    section.blocks.forEach((block, index) => {
      // The first block of a section always sits below a blank line.
      push(block.lines, index === 0 || block.blankBefore);
    });
  }

  // Only newlines are trimmed: a task marker needs the space after its closing
  // bracket, and dropping it turns `- [ ] ` back into a bullet whose text is a
  // literal `[]`. Trailing spaces inside the note are left alone for the same
  // reason.
  return output.join("\n").replace(/\n+$/, "");
}

/** One blank item, so a list with nothing in it still has something to type. */
const EMPTY_ITEM = "- [ ] ";

/**
 * Every line of a block becomes an open item, stripped of whatever list marker
 * it arrived with.
 */
function toItems(block: Block): Block[] {
  return block.lines
    .map((line) => line.replace(LIST_PREFIX_RE, "").trim())
    .filter((line) => line.length > 0)
    .map((line, index) => ({
      lines: [`- [ ] ${line}`],
      blankBefore: index === 0 ? block.blankBefore : false,
    }));
}

/**
 * Turn a note into a to-do list named `name`. The lines on top become the open
 * items and any days the note already archives are kept, so a note that lost
 * its title can be launched again without losing its history. A note that is
 * already a to-do list is returned untouched.
 */
export function startTodoMarkdown(markdown: string, name: string): string {
  const doc = parseBody(markdown);
  if (doc.name !== null) return markdown;

  doc.open.blocks = doc.open.blocks.flatMap(toItems);
  if (doc.open.blocks.length === 0) {
    doc.open.blocks.push({ lines: [EMPTY_ITEM], blankBefore: true });
  }
  doc.days.sort(byDateDesc);
  doc.name = name.trim();

  return serialize(doc);
}

/**
 * File every ticked item under the day it was ticked on and return the
 * rewritten note, or null when there is nothing to file. Reopened items go back
 * to the open list. The name in the title is never touched, so a list can be
 * renamed at any time without disturbing the rules around it.
 */
export function reconcileTodoMarkdown(
  markdown: string,
  today: string,
): string | null {
  const doc = parseTodo(markdown);
  if (!doc) return null;

  const filed: Block[] = [];
  doc.open.blocks = doc.open.blocks.filter((block) => {
    if (taskState(block.lines[0]) !== "checked") return true;
    filed.push(block);
    return false;
  });

  const reopened: Block[] = [];
  for (const section of doc.days) {
    section.blocks = section.blocks.filter((block) => {
      if (taskState(block.lines[0]) !== "unchecked") return true;
      reopened.push(block);
      return false;
    });
  }
  doc.days = doc.days.filter((section) => section.blocks.length > 0);

  if (filed.length === 0 && reopened.length === 0) return null;

  doc.open.blocks.unshift(...reopened.map(tight));

  if (filed.length > 0) {
    let section = doc.days.find((day) => day.date === today);
    if (!section) {
      section = { date: today, blocks: [] };
      doc.days.push(section);
    }
    section.blocks.push(...filed.map(tight));
  }

  doc.days.sort(byDateDesc);

  const next = serialize(doc);
  return next === markdown ? null : next;
}
