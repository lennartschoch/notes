// Where an agent's caret is, and what a keystroke does to the note — in plain
// markdown text, which is all an agent has. The web editor applies these same
// rules to the keys a person presses; spelling them out here means an agent
// that presses Enter inside a bullet list lands in the next item rather than in
// the middle of a dash, and that every "this is where you are" the tools print
// comes from one place.
//
// All of it is pure: text and a caret in, text and a caret out.

// The caret, addressed the way an agent reads a note: `text` names the words it
// wants to sit next to, `line`/`column` are the numbers read_note prints (a
// heading counts as a line), `offset` counts characters from the start.
export interface CursorTarget {
  text?: string;
  side?: "before" | "after";
  line?: number;
  column?: number;
  offset?: number;
}

export type CaretMatch =
  | { ok: true; caret: number }
  | { ok: false; reason: string };

// Character offset where a 1-based line starts.
function lineStart(content: string, line: number): number {
  return content
    .split("\n")
    .slice(0, Math.max(0, line - 1))
    .reduce((offset, text) => offset + text.length + 1, 0);
}

// Every offset in `content` where `text` occurs.
function occurrences(content: string, text: string): number[] {
  const hits: number[] = [];
  let from = content.indexOf(text);
  while (from !== -1) {
    hits.push(from);
    from = content.indexOf(text, from + text.length);
  }
  return hits;
}

// One place in a note where some text was found, and the words the note really
// has there (which is what a caret is then anchored on).
interface Hit {
  at: number;
  text: string;
}

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Every occurrence of `text` in the note's own coordinates. An exact search
// first; failing that, a word-by-word one, forgiving about case and whitespace,
// because words copied out of a note come back with the spacing of the screen
// rather than of the file. Offsets stay exact either way.
function findHits(content: string, text: string): Hit[] {
  const exact = occurrences(content, text);
  if (exact.length > 0) return exact.map((at) => ({ at, text }));
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const pattern = new RegExp(words.map(escapeRegExp).join("\\s+"), "gi");
  const hits: Hit[] = [];
  for (
    let match = pattern.exec(content);
    match;
    match = pattern.exec(content)
  ) {
    hits.push({ at: match.index, text: match[0] });
    if (hits.length >= 20) break;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return hits;
}

function lineRange(content: string, at: number): string {
  return `line ${placeOf(content, at).line}`;
}

// Resolves a caret address to a character offset. Every failure says what to
// send instead, because an agent that only hears "not found" retries the same call.
export function resolveCaret(
  content: string,
  target: CursorTarget,
): CaretMatch {
  const text = target.text ?? "";
  if (text.length > 0) {
    const hits = findHits(content, text);
    if (hits.length === 0) {
      return {
        ok: false,
        reason: `"${text}" is not in this note. Read it again (read_note) and copy the wording as it stands, or address the position by line.`,
      };
    }
    if (hits.length > 1) {
      return {
        ok: false,
        reason: `"${text}" matches ${hits.length} times (${hits
          .slice(0, 4)
          .map((hit) => lineRange(content, hit.at))
          .join(
            ", ",
          )}${hits.length > 4 ? ", \u2026" : ""}). Narrow it with more words, or say which one with line.`,
      };
    }
    const hit = hits[0]!;
    const caret = target.side === "before" ? hit.at : hit.at + hit.text.length;
    return { ok: true, caret };
  }

  if (target.line !== undefined || target.column !== undefined) {
    const line = target.line ?? 1;
    const rows = content.split("\n");
    if (!Number.isInteger(line) || line < 1 || line > rows.length) {
      return {
        ok: false,
        reason: `The note has ${rows.length} line(s), counted from 1; line ${line} is out of range.`,
      };
    }
    const column = target.column ?? 1;
    if (!Number.isFinite(column) || column < 1) {
      return { ok: false, reason: "column counts from 1 within the line." };
    }
    return {
      ok: true,
      caret:
        lineStart(content, line) + Math.min(column - 1, rows[line - 1]!.length),
    };
  }

  if (target.offset !== undefined) {
    if (!Number.isFinite(target.offset) || target.offset < 0) {
      return {
        ok: false,
        reason: "offset counts characters from 0 and is never negative.",
      };
    }
    const caret = Math.min(Math.trunc(target.offset), content.length);
    return { ok: true, caret };
  }

  return {
    ok: false,
    reason:
      "No position given: send text, or line/column, or offset - or leave the position out to use your caret.",
  };
}

// A caret the agent left in a note that has since moved: kept when the text it
// sat behind is still there, otherwise followed as far as it can be. This is the
// same relocation the editor does for a peer's caret, from the other end.
export function relocateCaret(
  content: string,
  remembered: { position: number; anchor: string },
): number {
  const clamp = (at: number) => Math.max(0, Math.min(at, content.length));
  if (remembered.anchor.trim().length === 0) return clamp(remembered.position);
  const hits = occurrences(content, remembered.anchor);
  if (hits.length === 1) return clamp(hits[0]! + remembered.anchor.length);
  if (hits.length > 1) {
    // Several copies of the same words: keep the closest one to where it was.
    const nearest = hits.reduce((best, at) =>
      Math.abs(at - remembered.position) < Math.abs(best - remembered.position)
        ? at
        : best,
    );
    return clamp(nearest + remembered.anchor.length);
  }
  return clamp(remembered.position);
}

// Where a caret sits: 1-based line and column, and the text of that line.
export interface CaretPlace {
  line: number;
  column: number;
  lineText: string;
}

export function placeOf(content: string, caret: number): CaretPlace {
  const at = Math.max(0, Math.min(Math.trunc(caret), content.length));
  const start = content.lastIndexOf("\n", at - 1) + 1;
  const end = content.indexOf("\n", at);
  return {
    line: content.slice(0, start).split("\n").length,
    column: at - start + 1,
    lineText: content.slice(start, end === -1 ? content.length : end),
  };
}

// ---- Keystrokes -----------------------------------------------------

const BULLET = /^(\s*)([-*+]|\d{1,3}[.)])(\s+)(.*)$/;
const QUOTE = /^(\s*)(>+)(\s+)(.*)$/;
const CHECKBOX = /^\s*[-*+]\s+\[[ xX]\]\s+/;

// The marker of the line the caret is on, as it is repeated on the next item.
function markerOf(line: string): string | null {
  const bullet = BULLET.exec(line);
  if (bullet) {
    const [, space, mark, gap] = bullet as RegExpExecArray;
    // The next item of a to-do list starts empty and unticked, however the one
    // being left behind was left.
    if (CHECKBOX.test(line)) return `${space}${mark}${gap}[ ] `;
    return `${space}${mark}${gap}`;
  }
  const quote = QUOTE.exec(line);
  return quote ? `${quote[1]}${quote[2]}${quote[3]}` : null;
}

// What Enter does at a caret: continue the item or quote it sits in, break out
// of an empty one (how a person ends a list), or start a new paragraph.
function enterAt(
  content: string,
  caret: number,
): { delete: number; text: string } {
  const start = content.lastIndexOf("\n", caret - 1) + 1;
  const line = content.slice(start, caret);
  const marker = markerOf(line);
  if (marker && line.trim().length > 0) {
    if (line.trim() === marker.trim()) {
      // The item is empty, so this Enter leaves the list: the marker goes away
      // and the line it was on becomes the blank line that follows the list.
      return { delete: caret - start, text: "" };
    }
    return { delete: 0, text: `\n${marker}` };
  }
  // One Enter means a new block, which markdown spells with a blank line - but a
  // note already broken into short lines has plenty of them, and piling up two
  // more would leave the document littered.
  return { delete: 0, text: "\n".repeat(blankLines(content, caret)) };
}

// How many newlines a paragraph break needs here to leave exactly one blank line
// between two blocks: none where the caret already has a line to itself, one after
// a short line, two in the middle of solid prose.
function blankLines(content: string, caret: number): number {
  const start = content.lastIndexOf("\n", caret - 1) + 1;
  if (start > 0 && content.slice(start, caret).trim().length === 0) return 0;
  let after = 0;
  while (content[caret + after] === "\n") after += 1;
  // Newlines with nothing beyond them but the end of the note separate nothing,
  // so they do not count as the blank line this one needs.
  if (content.slice(caret + after).trim().length === 0) after = 0;
  return Math.max(0, 2 - after);
}

export interface TypingOptions {
  // One word: put the space in front of it if it needs one.
  word?: boolean;
  // Delete before typing: the word before the caret, or the whole line.
  overwrite?: "word" | "line";
}

export interface TypingResult {
  content: string;
  caret: number;
  // What the keystrokes put into the note, for the answer to quote back.
  typed: string;
}

const isSpace = (char: string) => /\s/.test(char ?? "");

const isWordChar = (char: string) => /[\p{L}\p{N}'’_-]/u.test(char ?? "");

function wordStartBack(content: string, caret: number): number {
  let at = caret;
  while (at > 0 && isSpace(content[at - 1]!)) at -= 1;
  while (at > 0 && isWordChar(content[at - 1]!)) at -= 1;
  return at;
}

// Expands what an agent sent into keystrokes: characters, `\n` (or a real
// newline) for Enter, `\b` (or U+0008) for Backspace.
export function keystrokes(text: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\" && text[index + 1] === "n") {
      keys.push("\n");
      index += 1;
    } else if (char === "\\" && text[index + 1] === "b") {
      keys.push("\b");
      index += 1;
    } else if (char === "\r") {
      keys.push("\n");
    } else {
      keys.push(char);
    }
  }
  return keys;
}

// Types at a caret, one keystroke at a time, and says where the caret ended up.
export function typeText(
  content: string,
  caret: number,
  text: string,
  options: TypingOptions = {},
): TypingResult {
  let body = content;
  let at = Math.max(0, Math.min(caret, content.length));
  if (options.overwrite) {
    const from =
      options.overwrite === "word"
        ? wordStartBack(body, at)
        : body.lastIndexOf("\n", at - 1) + 1;
    const to =
      options.overwrite === "word"
        ? at
        : (() => {
            const end = body.indexOf("\n", at);
            return end === -1 ? body.length : end;
          })();
    body = `${body.slice(0, from)}${body.slice(to)}`;
    at = from;
  }
  const start = at;
  // `word` says the payload is one word of its own, which is what the space in
  // front of it is for.
  if (options.word && at > 0 && isWordChar(body[at - 1])) {
    body = `${body.slice(0, at)} ${body.slice(at)}`;
    at += 1;
  }
  const typedFrom = options.word ? at : start;
  for (const key of keystrokes(text)) {
    if (key === "\b") {
      if (at > 0) {
        body = `${body.slice(0, at - 1)}${body.slice(at)}`;
        at -= 1;
      }
      continue;
    }
    if (key === "\n") {
      const enter = enterAt(body, at);
      if (enter.delete > 0) {
        body = `${body.slice(0, at - enter.delete)}${body.slice(at)}`;
        at -= enter.delete;
      }
      body = `${body.slice(0, at)}${enter.text}${body.slice(at)}`;
      at += enter.text.length;
      continue;
    }
    body = `${body.slice(0, at)}${key}${body.slice(at)}`;
    at += key.length;
  }
  return {
    content: body,
    caret: at,
    typed: body.slice(Math.min(typedFrom, at), at),
  };
}

export const LINK_URL = /^(https?:\/\/|mailto:)[^\s<>"'`]+$/i;

// The one thing in text a person did not type that can mislead them: a link
// whose label says one thing and whose address says another. Writing the address
// out where everyone can read it beats a label they have to hover to check, so a
// link in handed-over text becomes its own words and its own destination — and a
// link that is meant to be one arrives through `link`, whose address is checked.
export function defuseLinks(text: string): string {
  return text
    .replace(/\[([^\]]*)]\(([^)\s]+)\)/g, (_all, label: string, url: string) =>
      label.trim().length === 0 || label.trim() === url
        ? url
        : `${label} (${url})`,
    )
    .replace(/<((?:https?|mailto):[^>\s]+)>/gi, "$1");
}

export function isLinkUrl(url: string): boolean {
  return LINK_URL.test(url.trim());
}

// Markdown for a link, in the shape the editor's own link button writes.
export function linkMarkdown(url: string, label?: string): string {
  const clean = url.trim().replace(/[()\s]/g, "%20");
  const text = (label ?? "").trim().length > 0 ? label! : url;
  return `[${text.replace(/[[\]]/g, "")}](${clean})`;
}

// ---- Seeing the note from where the agent stands ---------------------

// How many lines of a note an agent is handed at a time: long enough to read a
// note in one go, short enough that a note of a thousand lines is not a shock.
export const NOTE_PAGE_LINES = 80;

export interface NoteSight {
  // First line to show, 1-based (default 1).
  from?: number;
  // How many lines to show. With neither this nor `from`, the caret decides: a
  // window of `window` lines around it.
  lines?: number;
  // Draw the caret here, between two characters of its own line.
  caret?: number | null;
  // Lines of context around the caret, when the caret decides the range (2).
  window?: number;
}

export interface NoteView {
  view: string;
  place: CaretPlace | null;
  first: number;
  last: number;
  total: number;
}

// A note as a person reading it sees it: numbered lines, and the caret drawn
// where it stands. The numbers are the ones `line` takes, so what an agent reads
// is what it can address.
export function noteView(content: string, sight: NoteSight = {}): NoteView {
  const rows = content.split("\n");
  const place = sight.caret == null ? null : placeOf(content, sight.caret);
  let first: number;
  let last: number;
  if (place && sight.from === undefined && sight.lines === undefined) {
    const size = Math.max(0, Math.trunc(sight.window ?? 2));
    first = Math.max(1, place.line - size);
    last = Math.min(rows.length, place.line + size);
  } else {
    first = Math.min(
      Math.max(1, Math.trunc(sight.from ?? 1)),
      Math.max(1, rows.length),
    );
    const wanted = Math.trunc(sight.lines ?? NOTE_PAGE_LINES);
    last =
      wanted <= 0
        ? rows.length
        : Math.min(rows.length, first + Math.max(1, wanted) - 1);
  }
  const gutter = String(last).length;
  const body = rows.slice(first - 1, last).map((text, index) => {
    const line = first + index;
    return place?.line === line
      ? `${String(line).padStart(gutter)} | ${drawCaret(text, place.column - 1)}`
      : `${String(line).padStart(gutter)} | ${text}`;
  });
  return { view: body.join("\n"), place, first, last, total: rows.length };
}

function drawCaret(line: string, column: number): string {
  const at = Math.max(0, Math.min(column, line.length));
  return `${line.slice(0, at)}|${line.slice(at)}`;
}

// The offset just past the end of a line: where a reader's caret comes to rest
// after taking that much of a note in.
export function lineEnd(content: string, line: number): number {
  const rows = content.split("\n");
  const at = Math.min(Math.max(1, line), rows.length);
  return lineStart(content, at) + rows[at - 1]!.length;
}

// The line a page of reading should start at, given where the reader already
// stands: roughly the middle of the page, so there is context on both sides.
export function pageStart(
  content: string,
  caret: number | null | undefined,
  page: number,
): number {
  if (caret == null) return 1;
  const rows = content.split("\n").length;
  const line = placeOf(content, caret).line;
  return Math.max(1, Math.min(line - Math.floor(page / 2), rows - 1));
}
