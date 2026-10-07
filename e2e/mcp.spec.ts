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
          "update_note",
          "append_to_note",
          "replace_in_note",
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
      expect(out(read)).toContain("milk\neggs");

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
          iss: "https://lennartschoch.cloudflareaccess.com",
          aud: [
            "679c3d2a2a09ca7734cc9280a435035173c65e68ff08067e4665d216f75a563e",
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
