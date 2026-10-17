import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { noteTitle, searchContent, type SearchResults } from "shared";
import { listLines, metaLine, readNote, stamp } from "./format.js";
import {
  createNote,
  deleteNote,
  setNoteVisibility,
  updateNote,
} from "../changes.js";
import { getNote, listNotes } from "../store.js";
import { createCarets } from "./cursor.js";
import {
  isLinkUrl,
  linkMarkdown,
  noteView,
  placeOf,
  resolveCaret,
  defuseLinks,
  typeText,
  type CursorTarget,
  type TypingOptions,
} from "./text.js";
import type { Actor, Note, Visibility } from "../types.js";

// Every tool answers with plain text: notes are markdown documents, and an
// agent reading them back works better with a readable body than with JSON
// wrapped around it. Metadata (most importantly `version`, which writes need) is
// always printed alongside.
type ToolOutput = { content: [{ type: "text"; text: string }]; isError?: true };

// A tool's answer, plus where it leaves the agent's caret in the note. The app
// turns that into the line and column an agent can address again, and into the
// caret people watching the note see — so an agent never has to track its own
// position, and never gets to describe its own identity either.
interface ToolResult {
  content: string;
  at?: { caret: number; note: Note };
}

function where({ caret, note }: { caret: number; note: Note }): string {
  const place = placeOf(note.content, caret);
  const line = noteView(note.content, {
    from: place.line,
    lines: 1,
    caret,
  }).view;
  // The column is the insertion point itself, exactly as `column` takes it back
  // and exactly where the `|` below sits, so what an agent is told and what it
  // can send are the same number.
  return `\nYour caret: line ${place.line}, column ${place.column}.\n${line}`;
}

function ok(result: ToolResult): ToolOutput {
  return {
    content: [
      {
        type: "text",
        text: result.at ? result.content + where(result.at) : result.content,
      },
    ],
  };
}

function fail(text: string): ToolOutput {
  return { content: [{ type: "text", text }], isError: true };
}

const ID_DESCRIPTION =
  "Note id, as shown by list_notes / search_notes, or from a note://… resource link.";
const VERSION_DESCRIPTION =
  "The note version you last read. Omit it to write against the newest version; supply it to make the write fail instead of clobbering a concurrent edit.";
const ADDRESS_DESCRIPTION =
  "Where in the note: `after`/`before` some words of it (copied exactly), or `line` and optional `column` as read_note numbers them, or `offset` in characters. Omit them all to work at your caret, which is where your last read or edit left it.";

// Printed when a versioned write lost a race, with the current text inline so
// the caller can re-apply its change without another round trip. A localised
// edit gets more than that: the tool works out its own text from whatever the
// note says now, so sending it again without a version is a real retry.
function conflictNote(
  note: Note,
  sentVersion: number,
  local?: boolean,
): ToolOutput {
  return fail(
    [
      `Conflict: note "${note.id}" is at version ${note.version}, your edit was based on version ${sentVersion} (changed ${stamp(note.updatedAt)}).`,
      "Nothing was saved." +
        (local
          ? ` Somebody else changed the note after you read it. Send the same call again without a version to make your change to the note as it now stands, or re-apply it against the content below and retry with version ${note.version}.`
          : ` Re-apply your change against the current content below, then retry with version ${note.version}.`),
      "",
      "---",
      "",
      note.content,
    ].join("\n"),
  );
}

// A note the caller may not see. The message says what to do instead of just
// failing, because an agent otherwise retries the same call blindly.
function notVisible(id: string, email: string): ToolOutput {
  return fail(
    `No note with id "${id}" is visible to ${email}. Use list_notes to see which notes you can access.`,
  );
}

export function registerTools(server: McpServer, actor: Actor): void {
  // Reads and permissions key on the account; writes carry the full actor so a
  // change made by an agent is attributed as one. The carets are this session's
  // and outlive no more than it does.
  const email = actor.email;
  const carets = createCarets(actor);

  // Where the agent is in a note it has opened: remembered position, or the
  // address given in this call.
  function caretOf(note: Note, address: CursorTarget | null): CaretOf {
    if (address && hasAddress(address)) {
      const match = resolveCaret(note.content, address);
      return match.ok
        ? { ok: true, caret: match.caret }
        : { ok: false, reason: match.reason };
    }
    const remembered = carets.locate(note);
    if (remembered === null) {
      return {
        ok: false,
        reason: `You have no caret in note "${note.id}" yet. Read it first (read_note), or say where to work: ${ADDRESS_DESCRIPTION}`,
      };
    }
    return { ok: true, caret: remembered };
  }

  // Applies a write the agent made, then shows the agent making it: people in
  // the note see its caret land where the change ended, and the answer tells the
  // agent where that was in the coordinates it can address again.
  async function save(
    note: Note,
    content: string,
    version: number | undefined,
    edit: { caret: number; says: string; local?: boolean },
  ): Promise<ToolOutput> {
    if (content === note.content) {
      // Nothing to record, so nothing is recorded: saving anyway would bump the
      // version and tell everyone the note changed when it did not.
      carets.show(note, edit.caret, "viewing");
      return ok({
        content: `${edit.says}: nothing to change, the note already says exactly that.`,
        at: { caret: edit.caret, note },
      });
    }
    const expected = version ?? note.version;
    const result = await updateNote(note.id, content, expected, actor);
    if (result.status === "not_found") {
      return fail(`Note "${note.id}" is no longer visible to ${email}.`);
    }
    if (result.status === "conflict") {
      return conflictNote(result.note, expected, edit.local);
    }
    const saved = result.note;
    const caret = Math.min(edit.caret, saved.content.length);
    carets.show(saved, caret, "editing");
    return ok({
      content: `Saved note "${noteTitle(saved.content)}" (${saved.id}) → v${saved.version}.\n${metaLine(saved)}`,
      at: { caret, note: saved },
    });
  }

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Show which Notes user this connection acts as, and how many notes that can see.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (): Promise<ToolOutput> => {
      const notes = listNotes(email);
      const publicCount = notes.filter((n) => n.visibility === "public").length;
      return ok({
        content: `Acting as ${email}${actor.agent ? " (AI agent)" : ""}. Visible notes: ${notes.length} (${publicCount} public, ${notes.length - publicCount} private).`,
      });
    },
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "List notes you can see — yours plus everyone's public notes — newest first. Returns titles, ids, visibility and versions; use read_note for the full text.",
      inputSchema: {
        visibility: z
          .enum(["private", "public"])
          .optional()
          .describe("Only show notes with this visibility."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many notes to return (default 25)."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Skip this many notes, for paging (default 0)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ visibility, limit = 25, offset = 0 }): Promise<ToolOutput> => {
      const all = listNotes(email).filter(
        (note) => !visibility || note.visibility === visibility,
      );
      const page = all.slice(offset, offset + limit);
      if (all.length === 0) {
        return ok({
          content:
            "No notes are visible to you yet. Use create_note to add one.",
        });
      }
      if (page.length === 0) {
        return fail(
          `Offset ${offset} is past the end: ${all.length} notes are visible.`,
        );
      }
      const rangeEnd = offset + page.length;
      return ok({
        content: `${all.length} note(s) visible to ${email}, showing ${offset + 1}–${rangeEnd}, newest first:\n\n${listLines(page)}`,
      });
    },
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description:
        "Read a note as numbered lines, with its id, visibility and version. The numbers are addresses, not part of the text: quote the text after them when you find-and-replace, or pass a line number to work at one. Long notes come in pages: ask for the next one with `from`. Reading is how you get your caret into a note — it stops where the text shown ends, and people watching the note see it, so your place is known before you type. Returns the content plus the version writes need.",
      inputSchema: {
        id: z.string().min(1).describe(ID_DESCRIPTION),
        from: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("First line of the window to read, 1-based (default 1)."),
        lines: z
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe("How many lines to return (default: up to 80)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, from, lines }): Promise<ToolOutput> => {
      const note = getNote(id, email);
      if (!note) return notVisible(id, email);
      const caret = carets.locate(note);
      const shown = readNote(note, {
        from,
        lines,
        caret: from === undefined && lines === undefined ? caret : null,
      });
      // An agent reading along is present in the note: people watching see the
      // caret land where its reading stopped, under a "viewing" chip.
      carets.show(note, shown.caret, "viewing");
      return ok({ content: shown.text });
    },
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Search inside the notes you can see and return matching lines with line numbers. Plain substring search by default; set regex for a regular expression. The line numbers are the ones read_note prints and edits take.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "Text to look for, or a regular expression when regex is true.",
          ),
        regex: z
          .boolean()
          .optional()
          .describe("Treat query as a regular expression (default false)."),
        caseSensitive: z
          .boolean()
          .optional()
          .describe("Match case (default false)."),
        contextLines: z
          .number()
          .int()
          .min(0)
          .max(5)
          .optional()
          .describe("Include this many lines around each match (default 0)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum number of matching notes to return (default 20)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({
      query,
      regex = false,
      caseSensitive = false,
      contextLines = 0,
      limit = 20,
    }): Promise<ToolOutput> => {
      const results: string[] = [];
      let matchedNotes = 0;
      for (const note of listNotes(email)) {
        let search: SearchResults;
        try {
          search = searchContent(note.content, query, {
            regex,
            caseSensitive,
            contextLines,
          });
        } catch (error) {
          return fail(
            `Invalid regular expression: ${(error as Error).message}. Try a plain substring search.`,
          );
        }
        if (search.hits === 0) continue;
        matchedNotes += 1;
        if (results.length >= limit) continue;
        const body = search.lines.map(
          (entry) => `${entry.hit ? ">" : " "} ${entry.line}: ${entry.text}`,
        );
        results.push(
          `${noteTitle(note.content)}\n${metaLine(note)}\n${body.join("\n")}`,
        );
      }
      if (matchedNotes === 0) {
        return ok({
          content: `No notes match ${regex ? "pattern" : `"${query}"`}.`,
        });
      }
      const more =
        matchedNotes > limit
          ? `\n(+${matchedNotes - limit} more matching notes)`
          : "";
      return ok({
        content: `${matchedNotes} note(s) match ${regex ? `pattern ${query}` : `"${query}"`}${more}\n\n${results.join("\n\n")}`,
      });
    },
  );

  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description:
        "Create a new note with markdown content. Stays private unless you ask for public. Returns the new id and version.",
      inputSchema: {
        content: z
          .string()
          .optional()
          .describe("Markdown content for the new note."),
        title: z
          .string()
          .optional()
          .describe(
            "Optional heading; added as a leading '# …' line if content has none.",
          ),
        visibility: z
          .enum(["private", "public"])
          .optional()
          .describe("Visibility for the new note (default private)."),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ content, title, visibility }): Promise<ToolOutput> => {
      let body = content ?? "";
      if (title && !/^\s{0,3}#\s/.test(body)) {
        body = body.length > 0 ? `# ${title}\n\n${body}` : `# ${title}\n`;
      }
      const created = await createNote(body, actor, visibility);
      return ok({
        content: `Created note "${noteTitle(created.content)}" (${created.id}).\n${metaLine(created)}`,
      });
    },
  );

  server.registerTool(
    "type_in_note",
    {
      title: "Type at the caret",
      description:
        "Type into a note the way a person types, at the caret people watching can see move. `text` is typed keystroke by keystroke — a newline is the Enter key, so it starts a new list item inside a list and a new paragraph elsewhere, and a backspace deletes: it is content, not a patch, and cannot rewrite the lines around it. Use `word` for a single word (spaced and allowed to overwrite the one under the caret), `paste` for text that must stay as written (markdown links in it are written out rather than clicked), `link` to add a link. A markdown link inside text you were handed is written out as its words and its address instead of becoming clickable, so it cannot lie about where it goes. Say `after`, `before`, `line` or `offset` to work somewhere specific; otherwise you type where your last read or edit left you.",
      inputSchema: {
        id: z.string().min(1).describe(ID_DESCRIPTION),
        text: z
          .string()
          .optional()
          .describe(
            "Text to type, keystroke by keystroke: a newline acts as Enter, a backspace as Backspace.",
          ),
        word: z
          .string()
          .optional()
          .describe("A single word to type, spaced from what precedes it."),
        paste: z
          .string()
          .optional()
          .describe(
            "Text to insert exactly as given, with markdown syntax neutralised so it cannot become a link.",
          ),
        link: z.string().optional().describe("URL to insert as a link."),
        linkText: z
          .string()
          .optional()
          .describe("Label for the link (defaults to the address)."),
        after: z
          .string()
          .optional()
          .describe("Type just after this text from the note."),
        before: z
          .string()
          .optional()
          .describe("Type just before this text from the note."),
        line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Line to type on, as read_note numbers them."),
        column: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Column within that line, 1-based (default: its end)."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset to type at, from the start of the note."),
        enterFirst: z
          .boolean()
          .optional()
          .describe("Press Enter before typing (default false)."),
        enterAfter: z
          .boolean()
          .optional()
          .describe("Press Enter after typing (default false)."),
        overwrite: z
          .enum(["word", "line"])
          .optional()
          .describe(
            "Delete first: the word before the caret, or the whole line it is on.",
          ),
        version: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(VERSION_DESCRIPTION),
      },
      annotations: { destructiveHint: false },
    },
    async ({
      id,
      text,
      word,
      paste,
      link,
      linkText,
      after,
      before,
      line,
      column,
      offset,
      enterFirst = false,
      enterAfter = false,
      overwrite,
      version,
    }): Promise<ToolOutput> => {
      const note = getNote(id, email);
      if (!note) return notVisible(id, email);
      if (link !== undefined && !isLinkUrl(link)) {
        return fail(
          `"${link}" is not a http(s) or mailto address, so it will not be turned into a link.`,
        );
      }
      if (
        text === undefined &&
        word === undefined &&
        paste === undefined &&
        link === undefined &&
        !enterFirst &&
        !enterAfter
      ) {
        return fail(
          "Nothing to type: send text, word, paste, link, or ask for Enter.",
        );
      }

      const at = caretOf(
        note,
        addressOf({ after, before, line, column, offset }),
      );
      if (!at.ok) return fail(at.reason);

      const typed = typeAtCaret(note, at.caret, {
        text,
        word,
        paste,
        link,
        linkText,
        enterFirst,
        enterAfter,
        overwrite,
      });
      return save(note, typed.content, version, {
        caret: typed.caret,
        says: `Typed ${describeTyped(typed.typed)}`,
        local: true,
      });
    },
  );

  server.registerTool(
    "update_note",
    {
      title: "Replace note content",
      description:
        "Replace the entire content of a note with new markdown. Read the note first: content you send overwrites everything, and a stale version makes the write fail instead of clobbering someone else. For a change to one part of a shared note, prefer type_in_note or replace_in_note: they say what you changed rather than restating everything.",
      inputSchema: {
        id: z.string().min(1).describe(ID_DESCRIPTION),
        content: z
          .string()
          .describe("Complete new markdown content for the note."),
        version: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(VERSION_DESCRIPTION),
      },
      annotations: { destructiveHint: true },
    },
    async ({ id, content, version }): Promise<ToolOutput> => {
      const note = getNote(id, email);
      if (!note) return notVisible(id, email);
      // The caret goes to the end of what was written: a whole-document save has
      // no interesting position of its own.
      return save(note, content, version, {
        caret: content.length,
        says: `Replaced note "${noteTitle(content)}"`,
      });
    },
  );

  server.registerTool(
    "append_to_note",
    {
      title: "Append to note",
      description:
        "Add markdown to the end of a note without resending what is already there. Set heading to add it under a new '## …' section.",
      inputSchema: {
        id: z.string().min(1).describe(ID_DESCRIPTION),
        content: z.string().min(1).describe("Markdown to append."),
        heading: z
          .boolean()
          .optional()
          .describe(
            "Start a new '## ' section before the appended text (default false).",
          ),
        version: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(VERSION_DESCRIPTION),
      },
      annotations: { destructiveHint: false },
    },
    async ({ id, content, heading = false, version }): Promise<ToolOutput> => {
      const note = getNote(id, email);
      if (!note) return notVisible(id, email);
      const addition = heading ? `## ${content.trim()}\n` : content;
      const base = note.content.replace(/\s+$/, "");
      const merged = base.length > 0 ? `${base}\n\n${addition}` : addition;
      return save(note, merged, version, {
        caret: merged.length,
        says: `Appended to note "${noteTitle(merged)}"`,
        local: true,
      });
    },
  );

  server.registerTool(
    "replace_in_note",
    {
      title: "Find and replace in note",
      description:
        "Replace text inside a note without resending the whole document. Fails when the text is missing, or when it matches more than once and all is not set, so nothing is ever half-applied.",
      inputSchema: {
        id: z.string().min(1).describe(ID_DESCRIPTION),
        find: z
          .string()
          .min(1)
          .describe(
            "Exact text to find, or a regular expression when regex is true.",
          ),
        replacement: z
          .string()
          .describe(
            "Replacement text. Empty string deletes the match. Supports $1…$9 groups when regex is true.",
          ),
        regex: z
          .boolean()
          .optional()
          .describe("Treat find as a regular expression (default false)."),
        all: z
          .boolean()
          .optional()
          .describe(
            "Replace every match instead of requiring exactly one (default false).",
          ),
        version: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(VERSION_DESCRIPTION),
      },
      annotations: { destructiveHint: false },
    },
    async ({
      id,
      find,
      replacement,
      regex = false,
      all = false,
      version,
    }): Promise<ToolOutput> => {
      const note = getNote(id, email);
      if (!note) return notVisible(id, email);

      let pattern: RegExp;
      try {
        pattern = new RegExp(find, regex ? "gms" : "g");
      } catch (error) {
        return fail(`Invalid regular expression: ${(error as Error).message}`);
      }

      const matches = [...note.content.matchAll(pattern)];
      if (matches.length === 0) {
        return fail(
          `"${find}" was not found in note "${id}"; nothing changed. Read the note to check the exact wording.`,
        );
      }
      if (matches.length > 1 && !all) {
        return fail(
          `"${find}" matches ${matches.length} times in note "${id}". Pass all: true to replace every match, or make find more specific; nothing changed.`,
        );
      }

      // `replace` with the global flag rewrites every match; when a single
      // match was required there is exactly one to rewrite.
      const updated = note.content.replace(pattern, replacement);
      // Where the change ends, so the caret lands on it: the end of the last
      // thing replaced. Offsets shift as earlier replacements change the length,
      // and a capture-group replacement is longer or shorter than the words it
      // sends, so the total length change carries that — and the result is
      // clamped to the note.
      const last = matches[matches.length - 1]!;
      const shifted =
        (last.index ?? 0) +
        updated.length -
        note.content.length -
        matches.slice(0, -1).reduce((total, one) => total - one[0].length, 0);
      const caret =
        matches.length === 1
          ? (last.index ?? 0) + replacement.length
          : Math.max(
              shifted,
              updated.length - last[0].length + replacement.length,
            );
      return save(note, updated, version, {
        caret: Math.max(0, Math.min(caret, updated.length)),
        says: `Replaced ${matches.length > 1 ? `${matches.length}× ` : `"${last[0]}"`} in note "${noteTitle(updated)}"`,
        local: true,
      });
    },
  );

  server.registerTool(
    "set_note_visibility",
    {
      title: "Make note private or public",
      description:
        "Change who can see a note. public shares it, read and write, with everyone who can sign in to this Notes app; private hides it again. Only the owner can change it.",
      inputSchema: {
        id: z.string().min(1).describe(ID_DESCRIPTION),
        visibility: z.enum(["private", "public"]).describe("New visibility."),
      },
      annotations: { destructiveHint: false },
    },
    async ({ id, visibility }): Promise<ToolOutput> => {
      const note = getNote(id, email);
      if (!note) return notVisible(id, email);
      const updated = await setNoteVisibility(
        id,
        visibility as Visibility,
        actor,
      );
      if (!updated) {
        return fail(
          `Note "${id}" is owned by someone else, so its visibility cannot be changed (owner: ${note.owner || "unowned"}).`,
        );
      }
      return ok({
        content: `Note "${noteTitle(updated.content)}" is now ${updated.visibility}.\n${metaLine(updated)}`,
      });
    },
  );

  server.registerTool(
    "delete_note",
    {
      title: "Delete note",
      description:
        "Permanently delete a note and its history. Only the owner can delete it. This cannot be undone — consider making it private instead.",
      inputSchema: {
        id: z.string().min(1).describe(ID_DESCRIPTION),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ id }): Promise<ToolOutput> => {
      const note = getNote(id, email);
      if (!note) return notVisible(id, email);
      const removed = await deleteNote(id, actor);
      if (!removed) {
        return fail(
          `Note "${id}" is owned by ${note.owner || "someone else"} and cannot be deleted by ${email}.`,
        );
      }
      carets.forget(id);
      return ok({
        content: `Deleted note "${noteTitle(note.content)}" (${id}).`,
      });
    },
  );
}

// ---- type_in_note plumbing ------------------------------------------

type CaretOf = { ok: true; caret: number } | { ok: false; reason: string };

function hasAddress(address: CursorTarget): boolean {
  return (
    address.text !== undefined ||
    address.line !== undefined ||
    address.column !== undefined ||
    address.offset !== undefined
  );
}

function addressOf(fields: {
  after?: string;
  before?: string;
  line?: number;
  column?: number;
  offset?: number;
}): CursorTarget | null {
  if (fields.after !== undefined) return { text: fields.after, side: "after" };
  if (fields.before !== undefined)
    return { text: fields.before, side: "before" };
  if (fields.line !== undefined || fields.column !== undefined)
    return { line: fields.line ?? 1, column: fields.column };
  if (fields.offset !== undefined) return { offset: fields.offset };
  return null;
}

interface TypingInput {
  text?: string;
  word?: string;
  paste?: string;
  link?: string;
  linkText?: string;
  enterFirst: boolean;
  enterAfter: boolean;
  overwrite?: "word" | "line";
}

// A newline an agent sends is the Enter key, and what Enter *means* is the
// editor's rule, not the agent's: a new list item inside a list, a new paragraph
// elsewhere. The agent types words; the note keeps its shape.
//
// Types the payload of a type_in_note call, one gesture at a time, from where
// the agent's caret is.
function typeAtCaret(
  note: Note,
  caret: number,
  input: TypingInput,
): { content: string; caret: number; typed: string } {
  const chunks: { body: string; options: TypingOptions }[] = [];
  if (input.enterFirst) chunks.push({ body: "\n", options: {} });
  if (input.paste !== undefined) {
    chunks.push({
      // Text the agent was handed is not formatting, and must not render as a
      // link whose label was written by whoever wrote the text.
      body: defuseLinks(input.paste),
      options: {},
    });
  }
  if (input.text !== undefined) {
    chunks.push({
      body: input.text,
      options: {},
    });
  }
  if (input.word !== undefined) {
    // A word is spaced from the word it follows, the way typing one is.
    chunks.push({
      body: defuseLinks(input.word),
      options: { word: true },
    });
  }
  if (input.link !== undefined) {
    chunks.push({
      body: linkMarkdown(input.link, input.linkText),
      options: {},
    });
  }
  if (input.enterAfter) chunks.push({ body: "\n", options: {} });

  // Only the first gesture may clear what was there: a word typed after a paste
  // adds to it, it does not eat it.
  if (chunks.length > 0) chunks[0]!.options.overwrite ??= input.overwrite;

  let content = note.content;
  let at = caret;
  let typed = "";
  for (const chunk of chunks) {
    const result = typeText(content, at, chunk.body, chunk.options);
    content = result.content;
    at = result.caret;
    typed += result.typed;
  }
  return { content, caret: at, typed };
}

function describeTyped(typed: string): string {
  const clean = typed.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return "a line break";
  return clean.length > 40 ? `"${clean.slice(0, 39)}…"` : `"${clean}"`;
}
