// Rolling to-do lists.
//
// A to-do note is plain markdown with one shape:
//
//   # Todo · 2026-07-08
//
//   - [ ] water the plants
//
//   ## 2026-07-07
//
//   - [x] renew passport
//
// The level-1 heading is the title, and it always names the day the list is
// being worked on. Everything under it is still open. The level-2 headings
// below it, newest day first, archive the items that were ticked on that day.
//
// Ticking an item therefore files it: it leaves the open list, joins the day it
// was ticked on, and the title moves ahead to that day. Unticking an archived
// item reopens it and takes it back out of the day it was filed under.
//
// Everything here is pure string work on the markdown the editor serialises, so
// the rules of the list can be reasoned about without a live editor.

const TITLE_RE = /^#\s+Todo\s*·\s*(\d{4}-\d{2}-\d{2})\s*$/;
const DAY_RE = /^##\s+(\d{4}-\d{2}-\d{2})$/;
const TASK_RE = /^([-*+]|\d+\.)\s+\[([ xX])\]/;
const LIST_PREFIX_RE = /^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s*)?/;

/** Local ISO date (YYYY-MM-DD); used as the heading and as an archive key. */
export function todoDate(date = new Date()): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function todoHeading(date: string): string {
  return `# Todo · ${date}`;
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
  open: Section;
  days: Section[];
}

function parseTodo(markdown: string): TodoDoc | null {
  const lines = markdown.split("\n");
  const titleAt = lines.findIndex((line) => TITLE_RE.test(line.trim()));
  if (titleAt === -1) return null;

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

  return { open, days };
}

function serialize(doc: TodoDoc, title: string): string {
  const output: string[] = [todoHeading(title)];

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

  return output.join("\n").replace(/\s+$/, "");
}

/**
 * Turn a note into a to-do list dated `today`. Existing lines become the open
 * items; a note that is already a to-do list is returned untouched.
 */
export function startTodoMarkdown(markdown: string, today: string): string {
  if (isTodoMarkdown(markdown)) return markdown;

  const items = markdown
    .split("\n")
    .map((line) => line.replace(LIST_PREFIX_RE, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => `- [ ] ${line}`);

  const body = items.length > 0 ? items.join("\n") : "- [ ] ";
  return `${todoHeading(today)}\n\n${body}\n`;
}

/**
 * File every ticked item under the day it was ticked on and return the
 * rewritten note, or null when there is nothing to file. Reopened items return
 * to the open list, and the title follows whichever way the newest tick went,
 * so the title always names the day something last happened to the list.
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

  doc.days.sort((a, b) => (a.date! < b.date! ? 1 : -1));
  // The title is the day the list last moved, so it never lags behind today.
  const newest = doc.days[0]?.date ?? today;

  const next = serialize(doc, newest > today ? newest : today);
  return next === markdown ? null : next;
}
