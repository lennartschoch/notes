import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { noteTitle, searchContent } from "../noteText.js";
import type { SearchResults } from "../noteText.js";
import { fullNote, listLines, metaLine, stamp } from "./format.js";
import { noteRemoved, scheduleNoteChange } from "../notifier.js";
import { noteChanged } from "./hub.js";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  setNoteVisibility,
  updateNote,
} from "../store.js";
import { listStickers } from "../stickerStore.js";
import type { Note, Visibility } from "../types.js";

// Every tool answers with plain text: notes are markdown documents, and an
// agent reading them back works better with a readable body than with JSON
// wrapped around it. Metadata (most importantly `version`, which writes need)
// is always printed alongside.
type ToolOutput = { content: [{ type: "text"; text: string }]; isError?: true };

function ok(text: string): ToolOutput {
  return { content: [{ type: "text", text }] };
}

function fail(text: string): ToolOutput {
  return { content: [{ type: "text", text }], isError: true };
}

const ID_DESCRIPTION =
  "Note id, as shown by list_notes / search_notes, or from a note://… resource link.";
const VERSION_DESCRIPTION =
  "The note version you last read. Omit it to write against the newest version; supply it to make the write fail instead of clobbering a concurrent edit.";

// Printed when a versioned write lost a race, with the current text inline so
// the caller can re-apply its change without another round trip.
function conflictNote(note: Note, sentVersion: number): ToolOutput {
  return fail(
    [
      `Conflict: note "${note.id}" is at version ${note.version}, your edit was based on version ${sentVersion} (changed ${stamp(note.updatedAt)}).`,
      "Nothing was saved. Re-apply your change against the current content below, then retry with version: " +
        note.version,
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

// Applies a whole-content write, resolving the version the caller meant and
// mapping the store's three outcomes onto tool results.
async function writeContent(
  note: Note,
  email: string,
  content: string,
  version: number | undefined,
): Promise<ToolOutput> {
  const expected = version ?? note.version;
  const result = await updateNote(note.id, content, expected, email);
  if (result.status === "not_found") {
    return fail(`Note "${note.id}" is no longer visible to ${email}.`);
  }
  if (result.status === "conflict") {
    return conflictNote(result.note, expected);
  }
  // Same side effect as a web edit: shared notes notify the other people
  // they are shared with.
  if (result.note.visibility === "public") {
    scheduleNoteChange(result.note, email);
  }
  noteChanged(note.id);
  return ok(
    `Saved note "${noteTitle(result.note.content)}" (${note.id}) → v${result.note.version}.\n${metaLine(result.note)}`,
  );
}

export function registerTools(server: McpServer, email: string): void {
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
      return ok(
        `Acting as ${email}. Visible notes: ${notes.length} (${publicCount} public, ${notes.length - publicCount} private).`,
      );
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
        return ok(
          "No notes are visible to you yet. Use create_note to add one.",
        );
      }
      if (page.length === 0) {
        return fail(
          `Offset ${offset} is past the end: ${all.length} notes are visible.`,
        );
      }
      const rangeEnd = offset + page.length;
      return ok(
        `${all.length} note(s) visible to ${email}, showing ${offset + 1}–${rangeEnd}, newest first:\n\n${listLines(page)}`,
      );
    },
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description:
        "Read one note in full: its markdown content plus id, visibility, version and timestamps. Pass the version back when you edit it.",
      inputSchema: { id: z.string().min(1).describe(ID_DESCRIPTION) },
      annotations: { readOnlyHint: true },
    },
    async ({ id }): Promise<ToolOutput> => {
      const note = getNote(id, email);
      if (!note) return notVisible(id, email);
      return ok(fullNote(note));
    },
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Search inside the notes you can see and return matching lines with line numbers. Plain substring search by default; set regex for a regular expression.",
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
        return ok(`No notes match ${regex ? "pattern" : `"${query}"`}.`);
      }
      const more =
        matchedNotes > limit
          ? `\n(+${matchedNotes - limit} more matching notes)`
          : "";
      return ok(
        `${matchedNotes} note(s) match ${regex ? `pattern ${query}` : `"${query}"`}${more}\n\n${results.join("\n\n")}`,
      );
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
          .describe(
            'Markdown content. Stickers are inserted as [sticker id="…" name="…"] shortcodes (see list_stickers).',
          ),
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
      const note = await createNote(body, email);
      const finalNote =
        visibility && visibility !== note.visibility
          ? ((await setNoteVisibility(note.id, visibility, email)) ?? note)
          : note;
      noteChanged(finalNote.id);
      return ok(
        `Created note "${noteTitle(finalNote.content)}" (${finalNote.id}).\n${metaLine(finalNote)}`,
      );
    },
  );

  server.registerTool(
    "update_note",
    {
      title: "Replace note content",
      description:
        "Replace the entire content of a note with new markdown. Read the note first: content you send overwrites everything, and a stale version makes the write fail instead of clobbering someone else.",
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
      return writeContent(note, email, content, version);
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
      return writeContent(note, email, merged, version);
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
      return writeContent(note, email, updated, version);
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
        email,
      );
      if (!updated) {
        return fail(
          `Note "${id}" is owned by someone else, so its visibility cannot be changed (owner: ${note.owner || "unowned"}).`,
        );
      }
      noteChanged(id);
      return ok(
        `Note "${noteTitle(updated.content)}" is now ${updated.visibility}.\n${metaLine(updated)}`,
      );
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
      const removed = await deleteNote(id, email);
      if (!removed) {
        return fail(
          `Note "${id}" is owned by ${note.owner || "someone else"} and cannot be deleted by ${email}.`,
        );
      }
      noteRemoved(id);
      noteChanged(id);
      return ok(`Deleted note "${noteTitle(note.content)}" (${id}).`);
    },
  );

  server.registerTool(
    "list_stickers",
    {
      title: "List stickers",
      description:
        'List the shared sticker library. Embed one in a note as [sticker id="…" name="…"] and it renders as an image in the web app.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (): Promise<ToolOutput> => {
      const stickers = listStickers();
      if (stickers.length === 0) return ok("The sticker library is empty.");
      return ok(
        [
          `${stickers.length} sticker(s) in the shared library. Embed with: [sticker id="ID" name="NAME"]`,
          "",
          ...stickers.map(
            (sticker) => `- ${sticker.name || "unnamed"} · id ${sticker.id}`,
          ),
        ].join("\n"),
      );
    },
  );
}
