import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Actor } from "../types.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

const SERVER_VERSION = "1.0.0";

const INSTRUCTIONS = `Notes is a collaborative markdown notes app; this connection reads and writes the very same notes as the web UI.

Identity and permissions:
- Every call runs as the signed-in user this connection was opened with (whoami shows who that is). You see that user's own notes plus everyone's public notes.
- Public notes may be edited by anyone who can sign in; only the owner can change a note's visibility or delete it.

Working with notes:
- Content is markdown. Locate things with list_notes and search_notes, then read_note before editing.
- read_note prints numbered lines, up to a page at a time: the numbers are addresses ("3 | - buy milk"), not part of the text, and "from" pages on. Reading also puts you *in* the note - your caret lands where your reading stopped, and people watching it see that.
- Notes are collaborative, and the app shows an agent at work: reads, edits and typing appear as a caret in the note, with a chip saying when you are typing. Type where your caret is with type_in_note, and people see it as typing rather than as the note being swapped under them.
- type_in_note takes words of the note (after/before) or a line/column, and types keystroke by keystroke: a newline is the Enter key, so a list grows an item and prose gets a paragraph. replace_in_note changes exact words; update_note replaces the whole document.
- Every write bumps a version. Writes that carry the version you read fail if the note changed in the meantime and return the current text, so a concurrent edit is never silently overwritten. Send the same local edit again without a version to apply it to the note as it now stands.
- Anything markdown-shaped in word or paste is text, not formatting: a link someone sent you is written out with its address rather than becoming clickable. Use the link argument when you mean a link.
- delete_note is permanent and cannot be undone. Prefer set_note_visibility to private unless deletion was explicitly requested.

Notes are also exposed as resources (notes://index and note://{id}) for clients that attach context instead of calling tools.`;

// One McpServer instance per MCP session: the identity of the caller is closed
// over by every tool callback, so a session can never act as somebody else and
// no request has to carry an identity of its own.
export function buildMcpServer(actor: Actor): McpServer {
  const server = new McpServer(
    { name: "notes", version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, actor);
  registerResources(server, actor.email);
  return server;
}
