import {
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getNote, listNotes } from "../store.js";
import { noteTitle } from "../noteText.js";
import { fullNote, listLines } from "./format.js";

// Notes are also exposed as resources, so a client can attach a note (or the
// whole index) to a prompt as context instead of going through a tool call.
// Reading is enough to get an id and version; edits still go through the tools.

export const NOTES_INDEX_URI = "notes://index";

export function registerResources(server: McpServer, email: string): void {
  server.registerResource(
    "notes-index",
    NOTES_INDEX_URI,
    {
      title: "Notes index",
      description:
        "Every note visible to you, newest first, with title, id, visibility and version.",
      mimeType: "text/plain",
    },
    async () => {
      const notes = listNotes(email);
      const text =
        notes.length === 0
          ? `No notes are visible to ${email} yet.`
          : `${notes.length} note(s) visible to ${email}, newest first:\n\n${listLines(notes)}`;
      return {
        contents: [{ uri: NOTES_INDEX_URI, mimeType: "text/plain", text }],
      };
    },
  );

  server.registerResource(
    "note",
    new ResourceTemplate("note://{id}", {
      list: async () => ({
        resources: listNotes(email).map((note) => ({
          uri: `note://${note.id}`,
          name: note.id,
          title: noteTitle(note.content),
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "Note",
      description:
        "One note as markdown, with its id, visibility and version in the header.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const id = String(
        Array.isArray(variables.id) ? variables.id[0] : (variables.id ?? ""),
      );
      const note = getNote(id, email);
      if (!note) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `No note with id "${id}" is visible to ${email}.`,
        );
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: fullNote(note),
          },
        ],
      };
    },
  );
}
