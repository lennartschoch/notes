import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

const SERVER_VERSION = "1.0.0";

const INSTRUCTIONS = `Notes is a collaborative markdown notes app; this connection reads and writes the very same notes as the web UI.

Identity and permissions:
- Every call runs as the signed-in user this connection was opened with (whoami shows who that is). You see that user's own notes plus everyone's public notes.
- Public notes may be edited by anyone who can sign in; only the owner can change a note's visibility or delete it.

Working with notes:
- Content is markdown. Locate things with list_notes and search_notes, then read_note before editing.
- Every write bumps a version. Writes that carry the version you read fail if the note changed in the meantime and return the current text, so a concurrent edit is never silently overwritten. Omit the version only when writing against whatever is newest is acceptable.
- Prefer append_to_note and replace_in_note for local changes; update_note replaces the whole document.
- delete_note is permanent and cannot be undone. Prefer set_note_visibility to private unless deletion was explicitly requested.

Notes are also exposed as resources (notes://index and note://{id}) for clients that attach context instead of calling tools.`;

// One McpServer instance per MCP session: the identity of the caller is closed
// over by every tool callback, so a session can never act as somebody else and
// no request has to carry an identity of its own.
export function buildMcpServer(email: string): McpServer {
  const server = new McpServer(
    { name: "notes", version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, email);
  registerResources(server, email);
  return server;
}
