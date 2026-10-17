import { expect, test, type APIRequestContext } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

const port = Number(process.env.E2E_PORT ?? 4100);
const MCP_URL = `http://127.0.0.1:${port}/mcp`;

// Dedicated identities so the identity tests stay readable; other specs leave
// public notes behind in the same store, so assertions match on content from
// this file rather than on how many notes exist.
const ALICE = "alice.mcp@test";
const BOB = "bob.mcp@test";

// Makes every note this suite looks for findable even when other suites have
// created similar ones.
const run = `${Date.now()}`;

async function connect(headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "e2e-mcp", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return client;
}

async function connectAs(email: string): Promise<Client> {
  return connect({ "x-dev-user-email": email });
}

// An MCP connection the app treats as an agent rather than as the person whose
// account it uses (see server/src/mcp/auth.ts).
async function connectAsAgent(email: string): Promise<Client> {
  return connect({ "x-dev-user-email": email, "x-dev-agent": "1" });
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function out(result: CallToolResult): string {
  return result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

// The note id printed in the metadata header of a create/save result.
function noteId(text: string): string {
  const match = /id: ([0-9a-f-]{36})/.exec(text);
  expect(match).not.toBeNull();
  return String(match?.[1]);
}

// The markdown the server holds for a note, read the way the web app reads it.
async function savedContent(
  request: APIRequestContext,
  email: string,
  id: string,
): Promise<string> {
  const response = await request.get(`/api/notes/${id}`, {
    headers: { "x-dev-user-email": email },
  });
  expect(response.ok()).toBe(true);
  return String((await response.json()).content);
}

// A to-do list files ticked items under a heading named for the day they were
// ticked, which is a local date, so the spec expects the heading the server
// writes rather than inventing one.
function isoDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

const TODAY = isoDate(new Date());

test.describe("MCP server", () => {
  test("offers the note tools and resources to a signed-in agent", async () => {
    const client = await connectAs(ALICE);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "whoami",
          "list_notes",
          "read_note",
          "search_notes",
          "create_note",
          "type_in_note",
          "update_note",
          "append_to_note",
          "replace_in_note",
          "start_todo_list",
          "set_note_visibility",
          "delete_note",
        ]),
      );

      const identity = await call(client, "whoami");
      expect(out(identity)).toContain(ALICE);

      const index = await client.readResource({ uri: "notes://index" });
      expect(index.contents[0]?.mimeType).toBe("text/plain");

      expect(client.getInstructions()).toContain("version");
    } finally {
      await client.close();
    }
  });

  test("creates, edits and deletes a note while tracking versions", async () => {
    const client = await connectAs(ALICE);
    try {
      const title = `Groceries ${run}`;
      const created = await call(client, "create_note", {
        title,
        content: "milk\neggs",
      });
      expect(created.isError).toBeUndefined();
      const id = noteId(out(created));
      expect(out(created)).toContain("private · v0");

      const read = await call(client, "read_note", { id });
      expect(out(read)).toContain(title);
      // Lines are numbered, because the numbers are what an edit is addressed by.
      expect(out(read)).toContain("3 | milk\n4 | eggs");

      const appended = await call(client, "append_to_note", {
        id,
        content: "coffee",
      });
      expect(out(appended)).toContain("→ v1");

      const replaced = await call(client, "replace_in_note", {
        id,
        find: "eggs",
        replacement: "oat milk",
      });
      expect(out(replaced)).toContain("→ v2");
      expect(out(await call(client, "read_note", { id }))).toContain(
        "oat milk",
      );

      // An ambiguous find and a miss both change nothing.
      const ambiguous = await call(client, "replace_in_note", {
        id,
        find: "milk",
        replacement: "bread",
      });
      expect(ambiguous.isError).toBe(true);
      expect(out(ambiguous)).toContain("matches 2 times");

      // A write based on a stale version is refused and carries the current text.
      const stale = await call(client, "update_note", {
        id,
        content: "overwrite everything",
        version: 1,
      });
      expect(stale.isError).toBe(true);
      expect(out(stale)).toContain("Conflict");
      expect(out(stale)).toContain("oat milk");
      expect(out(await call(client, "read_note", { id }))).not.toContain(
        "overwrite everything",
      );

      expect(out(await call(client, "delete_note", { id }))).toContain(
        "Deleted",
      );
      expect((await call(client, "read_note", { id })).isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("searches inside notes with plain text and regular expressions", async () => {
    const client = await connectAs(ALICE);
    try {
      const marker = `ketchup-${run}`;
      const created = await call(client, "create_note", {
        content: `# Party ${run}\n\n- buy ${marker}\n- invite people\n`,
      });
      const id = noteId(out(created));

      const plain = await call(client, "search_notes", { query: marker });
      expect(out(plain)).toContain(id);
      expect(out(plain)).toContain(marker);

      const withContext = await call(client, "search_notes", {
        query: marker,
        contextLines: 1,
      });
      expect(out(withContext)).toContain("invite people");

      const regex = await call(client, "search_notes", {
        query: `^\\- buy ${marker}$`,
        regex: true,
      });
      expect(out(regex)).toContain(marker);

      const badRegex = await call(client, "search_notes", {
        query: "(",
        regex: true,
      });
      expect(badRegex.isError).toBe(true);
      expect(out(badRegex)).toContain("Invalid regular expression");

      await call(client, "delete_note", { id });
    } finally {
      await client.close();
    }
  });

  test("shows an agent only what its own identity may see", async () => {
    const alice = await connectAs(ALICE);
    const bob = await connectAs(BOB);
    try {
      const secret = `private-${run}`;
      const privateNote = await call(alice, "create_note", { content: secret });
      const privateId = noteId(out(privateNote));

      const shared = `public-${run}`;
      const publicNote = await call(alice, "create_note", {
        content: shared,
        visibility: "public",
      });
      const publicId = noteId(out(publicNote));
      expect(out(publicNote)).toContain("public");

      const bobSees = await call(bob, "list_notes", {});
      expect(out(bobSees)).toContain(shared);
      expect(out(bobSees)).not.toContain(secret);

      // Anyone may edit a public note…
      expect(
        out(
          await call(bob, "append_to_note", { id: publicId, content: "bob" }),
        ),
      ).toContain("→ v1");
      // …but only the owner manages it.
      const demote = await call(bob, "set_note_visibility", {
        id: publicId,
        visibility: "private",
      });
      expect(demote.isError).toBe(true);
      expect((await call(bob, "delete_note", { id: publicId })).isError).toBe(
        true,
      );
      expect((await call(bob, "read_note", { id: privateId })).isError).toBe(
        true,
      );

      await call(alice, "delete_note", { id: privateId });
      await call(alice, "delete_note", { id: publicId });
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  test("matches a plain find as written, and a pattern only when asked", async () => {
    // Ticking a box means quoting a line that is nothing but characters a
    // regular expression would read as syntax, so "find this text" has to mean
    // the text — and a replacement that quotes money has to keep its `$`.
    const client = await connectAs(ALICE);
    try {
      const created = await call(client, "create_note", {
        content: `Plain find ${run}\n\n- [ ] fix the lamp\n- price: $10\n`,
      });
      const id = noteId(out(created));

      expect(
        out(
          await call(client, "replace_in_note", {
            id,
            find: "- [ ] fix the lamp",
            replacement: "- [x] fix the lamp",
          }),
        ),
      ).toContain("\u2192 v1");
      expect(out(await call(client, "read_note", { id }))).toContain(
        "- [x] fix the lamp",
      );

      expect(
        out(
          await call(client, "replace_in_note", {
            id,
            find: "price: $10",
            replacement: "price: $20",
          }),
        ),
      ).toContain("\u2192 v2");
      expect(out(await call(client, "read_note", { id }))).toContain(
        "price: $20",
      );

      // An opt-in pattern still behaves like one.
      expect(
        out(
          await call(client, "replace_in_note", {
            id,
            find: "\\[x\\] fix",
            replacement: "[x] mend",
            regex: true,
          }),
        ),
      ).toContain("\u2192 v3");
      expect(out(await call(client, "read_note", { id }))).toContain(
        "- [x] mend the lamp",
      );

      await call(client, "delete_note", { id });
    } finally {
      await client.close();
    }
  });

  test("files a ticked item on the day an agent ticked it, with no editor open", async ({
    request,
  }) => {
    // A to-do list keeps its ticked items under a heading for the day they were
    // ticked. That rule used to live only in the web editor, so an agent's tick
    // left the item in the open list — and the next person to type in the note
    // filed it under their own day. One identity, one note, no browser.
    const agent = await connectAsAgent(ALICE);
    const stored = (note: string) => savedContent(request, ALICE, note);

    try {
      const created = await call(agent, "create_note", {
        content: `# Todo · Desk ${run}\n\n- [ ] fix the lamp\n- [x] clear the drawers\n`,
      });
      expect(created.isError).toBeUndefined();
      const id = noteId(out(created));

      // The tick that arrived with the note was filed on the way in.
      expect(await stored(id)).toBe(
        `# Todo · Desk ${run}\n\n- [ ] fix the lamp\n\n## ${TODAY}\n\n- [x] clear the drawers`,
      );

      // Ticking the other item is a whole edit by itself: nobody has to open
      // the note in a browser for the item to land on the day it was ticked.
      const ticked = await call(agent, "replace_in_note", {
        id,
        find: "- [ ] fix the lamp",
        replacement: "- [x] fix the lamp",
      });
      expect(out(ticked)).toContain("\u2192 v1");
      expect(await stored(id)).toBe(
        `# Todo · Desk ${run}\n\n## ${TODAY}\n\n- [x] clear the drawers\n- [x] fix the lamp`,
      );

      // And emptying a box brings the item back out of the day it filed in.
      const reopened = await call(agent, "replace_in_note", {
        id,
        find: "- [x] fix the lamp",
        replacement: "- [ ] fix the lamp",
      });
      expect(out(reopened)).toContain("\u2192 v2");
      expect(await stored(id)).toBe(
        `# Todo · Desk ${run}\n\n- [ ] fix the lamp\n\n## ${TODAY}\n\n- [x] clear the drawers`,
      );

      await call(agent, "delete_note", { id });
    } finally {
      await agent.close();
    }
  });

  test("launches a to-do list, then keeps its own end of the bargain", async ({
    request,
  }) => {
    // The shape of a list used to be something an agent could only imitate by
    // hand: the heading that makes a note a list, the open items, the day
    // headings. Now one call launches it, and the edits after it are ordinary.
    const agent = await connectAsAgent(ALICE);
    try {
      const created = await call(agent, "create_note", {
        content: `buy milk\nbook the mover`,
      });
      const id = noteId(out(created));

      const launched = await call(agent, "start_todo_list", {
        id,
        name: `Errands ${run}`,
      });
      expect(out(launched)).toContain("\u2192 v1");
      expect(await savedContent(request, ALICE, id)).toBe(
        `# Todo · Errands ${run}\n\n- [ ] buy milk\n- [ ] book the mover`,
      );

      // Launching is not renaming: the name a list was given stays put.
      const again = await call(agent, "start_todo_list", {
        id,
        name: "Renamed",
      });
      expect(out(again)).toContain("already the to-do list");
      expect(out(again)).toContain(`"Errands ${run}"`);
      expect(await savedContent(request, ALICE, id)).toContain(
        `# Todo · Errands ${run}`,
      );

      // Half a call is refused rather than quietly ignored.
      const mixed = await call(agent, "start_todo_list", {
        id,
        content: "and a lightbulb",
      });
      expect(mixed.isError).toBe(true);
      expect(out(mixed)).toContain("only applies to a new list");

      // Ticking a box is the whole edit, and the list files the item itself.
      expect(
        out(
          await call(agent, "replace_in_note", {
            id,
            find: "- [ ] buy milk",
            replacement: "- [x] buy milk",
          }),
        ),
      ).toContain("\u2192 v2");
      expect(await savedContent(request, ALICE, id)).toBe(
        `# Todo · Errands ${run}\n\n- [ ] book the mover\n\n## ${TODAY}\n\n- [x] buy milk`,
      );

      // A day heading an agent wrote for itself is answered with the rule.
      const handFiled = await call(agent, "update_note", {
        id,
        content: `# Todo · Errands ${run}\n\n- [ ] book the mover\n\n## 2019-04-01\n\n- [x] buy milk`,
      });
      expect(out(handFiled)).toContain("writes its own");

      await call(agent, "delete_note", { id });
    } finally {
      await agent.close();
    }
  });

  test("starts a list that does not have a note yet", async ({ request }) => {
    const agent = await connectAsAgent(ALICE);
    try {
      const created = await call(agent, "start_todo_list", {
        name: `Bin day ${run}`,
        content: "sharpen the shears\ncancel the gym",
      });
      expect(out(created)).toContain(`Created to-do list "Bin day ${run}"`);
      const id = noteId(out(created));
      expect(await savedContent(request, ALICE, id)).toBe(
        `# Todo · Bin day ${run}\n\n- [ ] sharpen the shears\n- [ ] cancel the gym`,
      );

      // Ask for nothing and you get what the app offers by default: its name for
      // an unnamed list, and one empty item to type into.
      const blank = await call(agent, "start_todo_list", {});
      expect(out(blank)).toContain(`Created to-do list "My to-dos"`);
      const blankId = noteId(out(blank));
      expect(await savedContent(request, ALICE, blankId)).toBe(
        `# Todo · My to-dos\n\n- [ ] `,
      );

      await call(agent, "delete_note", { id });
      await call(agent, "delete_note", { id: blankId });
    } finally {
      await agent.close();
    }
  });

  test("tells another open session that notes changed", async () => {
    const alice = await connectAs(ALICE);
    const bob = await connectAs(BOB);
    try {
      const changed = new Promise<string>((resolve) => {
        bob.setNotificationHandler(
          ResourceUpdatedNotificationSchema,
          async (notification) => resolve(notification.params.uri),
        );
      });
      // Both resource notification types arrive; the list one keeps the test
      // honest without the client logging an unhandled notification.
      bob.setNotificationHandler(
        ResourceListChangedNotificationSchema,
        async () => undefined,
      );

      const created = await call(alice, "create_note", {
        content: `shared across sessions ${run}`,
        visibility: "public",
      });
      const id = noteId(out(created));

      await expect(changed).resolves.toBe(`note://${id}`);
      await call(alice, "delete_note", { id });
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  test("tells open sessions about edits made through the REST API", async ({
    request,
  }) => {
    // The web UI writes notes over REST; an agent watching a shared note has
    // to learn about those edits too, not only about agent-made ones.
    const created = await request.post("/api/notes", {
      headers: { "x-dev-user-email": ALICE },
      data: { content: `edited from the web ${run}` },
    });
    expect(created.ok()).toBe(true);
    const note = (await created.json()) as { id: string; version: number };

    const bob = await connectAs(BOB);
    try {
      const changed = new Promise<string>((resolve) => {
        bob.setNotificationHandler(
          ResourceUpdatedNotificationSchema,
          async (notification) => resolve(notification.params.uri),
        );
      });
      const updated = await request.put(`/api/notes/${note.id}`, {
        headers: { "x-dev-user-email": ALICE },
        data: { content: `edited from the web again ${run}`, version: 0 },
      });
      expect(updated.ok()).toBe(true);
      await expect(changed).resolves.toBe(`note://${note.id}`);
    } finally {
      await bob.close();
      await request.delete(`/api/notes/${note.id}`, {
        headers: { "x-dev-user-email": ALICE },
      });
    }
  });

  test("refuses requests without a live session", async ({ request }) => {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "0.0.0" },
      },
    };

    const unknown = await request.post(MCP_URL, {
      headers: { "mcp-session-id": "00000000-0000-4000-8000-000000000000" },
      data: { ...initialize, id: 2 },
    });
    expect(unknown.status()).toBe(404);

    // A request that is not an initialize handshake cannot open a session.
    const noHandshake = await request.post(MCP_URL, {
      data: { jsonrpc: "2.0", id: 3, method: "ping" },
    });
    expect(noHandshake.status()).toBe(400);

    const health = await (request as APIRequestContext).get("/api/health");
    expect(health.ok()).toBe(true);
  });

  test("verifies an Authorization bearer token rather than trusting it", async () => {
    // The header is an alternative spelling of the Access application token, so
    // it has to clear the same signature check - and having sent one rules out
    // the dev identity fallback, which is what makes this a 401 and not a
    // session.
    await expect(
      connect({ authorization: "Bearer not-a-cloudflare-access-token" }),
    ).rejects.toThrow();
  });

  test("refuses an Access-shaped token that Cloudflare did not sign", async () => {
    // Header, issuer and audience all look plausible; only the signature is
    // Cloudflare's to provide.
    const unsigned = [
      Buffer.from(
        JSON.stringify({ alg: "RS256", kid: "deadbeef", typ: "JWT" }),
      ).toString("base64url"),
      Buffer.from(
        JSON.stringify({
          iss: "https://example.cloudflareaccess.com",
          aud: [
            "32eafc7626e974616deaf0dc3ce63d7bcbed58a2731e84d06bc3cdf1b53c4228",
          ],
          email: ALICE,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString("base64url"),
      "signature-nobody-signed",
    ].join(".");

    await expect(
      connect({ "cf-access-jwt-assertion": unsigned }),
    ).rejects.toThrow();
  });
});
