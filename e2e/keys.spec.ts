import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const port = Number(process.env.E2E_PORT ?? 4100);
const MCP_URL = `http://127.0.0.1:${port}/mcp`;

// API keys: this app's own machine credential, so an agent reaches the notes with
// nothing but the app. These specs walk the life of one — minted by a person, used
// as that person's whole account, revoked while it is connected — because the
// failures worth fearing are spread across those three moments.
const ALICE = "alice.keys@test";
const BOB = "bob.keys@test";

const run = `${Date.now()}`;

interface KeyRow {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function as(email: string): Record<string, string> {
  return { "x-dev-user-email": email };
}

async function mint(
  request: APIRequestContext,
  email: string,
  name: string,
): Promise<{ key: KeyRow; secret: string }> {
  const response = await request.post("/api/keys", {
    headers: as(email),
    data: { name },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { key: KeyRow; secret: string };
}

async function connectWithSecret(secret: string): Promise<Client> {
  const client = new Client({ name: "e2e-key", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${secret}` } },
  });
  await client.connect(transport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
  };
  return result.content
    .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
    .join("\n");
}

function chip(page: Page, titleSubstring: string) {
  return page.locator(`[title*="${titleSubstring}"]`);
}

async function createNote(
  request: APIRequestContext,
  email: string,
  content: string,
  visibility: "private" | "public" = "private",
): Promise<string> {
  const created = await request.post("/api/notes", {
    headers: as(email),
    data: { content },
  });
  expect(created.status()).toBe(201);
  const id = String((await created.json()).id);
  if (visibility !== "private") {
    const patched = await request.patch(`/api/notes/${id}`, {
      headers: as(email),
      data: { visibility },
    });
    expect(patched.status()).toBe(200);
  }
  return id;
}

test("a key is shown once, kept as a hash, and acts as its whole account", async ({
  request,
}) => {
  const title = `Keys private ${run}`;
  const noteId = await createNote(request, ALICE, `# ${title}`);
  const { key, secret } = await mint(request, ALICE, "laptop agent");

  expect(secret.startsWith("notes_")).toBe(true);

  // The list is for recognising a key, not for using one: after creation the
  // plaintext exists nowhere the owner can read it back.
  const listed = await request.get("/api/keys", { headers: as(ALICE) });
  expect(listed.status()).toBe(200);
  const body = await listed.text();
  const rows = JSON.parse(body) as KeyRow[];
  expect(
    rows.some((row) => row.id === key.id && row.name === "laptop agent"),
  ).toBe(true);
  expect(body.includes(secret)).toBe(false);
  expect(key.hint.length).toBeGreaterThan(0);

  // The whole account, over REST and over MCP, with no Cloudflare in sight.
  const withKey = await request.get("/api/notes", {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(withKey.status()).toBe(200);
  expect((await withKey.text()).includes(title)).toBe(true);

  const client = await connectWithSecret(secret);
  try {
    expect(await call(client, "read_note", { id: noteId })).toContain(title);
    const who = await call(client, "whoami");
    expect(who).toContain(ALICE);
    // A key is a machine, whatever the person holding it is doing with it.
    expect(who).toContain("agent");
    expect(
      await call(client, "create_note", { content: `# Kept ${run}` }),
    ).toContain("id:");
  } finally {
    await client.close();
  }

  // What the agent wrote belongs to the account, and stays as private as the
  // account made it.
  const mine = await request.get("/api/notes", { headers: as(ALICE) });
  expect((await mine.text()).includes(`Kept ${run}`)).toBe(true);
  const theirs = await request.get("/api/notes", { headers: as(BOB) });
  expect((await theirs.text()).includes(`Kept ${run}`)).toBe(false);
});

test("a key cannot manage keys", async ({ request }) => {
  const { secret } = await mint(request, ALICE, "second agent");
  const headers = { authorization: `Bearer ${secret}` };

  // A credential that could hand out credentials would outlive its own
  // revocation — and a key's name belongs to its owner, not to the agent.
  expect((await request.get("/api/keys", { headers })).status()).toBe(403);
  expect(
    (
      await request.post("/api/keys", { headers, data: { name: "escapism" } })
    ).status(),
  ).toBe(403);
  expect((await request.delete("/api/keys/nope", { headers })).status()).toBe(
    403,
  );

  // While the account's own notes stay reachable with it: the refusal is about
  // keys, not a grant that arrived broken.
  expect((await request.get("/api/notes", { headers })).status()).toBe(200);
});

test("the panel mints a key once, and revokes it with a second thought", async ({
  page,
  request,
}) => {
  // The human half of the feature: a key can be read out of the app exactly
  // once, and the list afterwards is a list of what to keep an eye on.
  const asked: string[] = [];
  page.on("dialog", async (dialog) => {
    asked.push(dialog.message());
    await dialog.accept();
  });
  const headers = as(ALICE);
  // No notes at all: the panel is reached from the sidebar header, and leaving a
  // note behind here would upset the empty-state assertions of later specs.
  await page.setExtraHTTPHeaders(headers);
  await page.goto("/");

  await page.getByRole("button", { name: "Agent keys" }).click();
  const dialog = page.getByRole("dialog", { name: "Agent keys" });
  await expect(dialog).toBeVisible();

  await page.getByLabel("Key name").fill(`Panel ${run}`);
  await page.getByRole("button", { name: "Create key" }).click();
  const secret = await page.locator("[data-api-secret]").textContent();
  expect(String(secret).startsWith("notes_")).toBe(true);

  // Closing the panel is the last time anybody sees it.
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Agent keys" }).click();
  await expect(page.locator("[data-api-secret]")).toHaveCount(0);
  const row = page
    .locator("[data-api-key]")
    .filter({ hasText: `Panel ${run}` });
  await expect(row).toBeVisible();

  // And revocation is a person's whole action, not one that needs the console.
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toHaveCount(0);
  // Revoking asks first: a key is a whole account, and the click is not always
  // the intention.
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain(`Panel ${run}`);

  const keys = (await (await request.get("/api/keys", { headers })).json()) as [
    KeyRow,
  ];
  expect(keys.some((row) => row.name === `Panel ${run}`)).toBe(false);
  await expect(
    connectWithSecret(String(secret)).catch(() => "rejected"),
  ).resolves.toBe("rejected");
});

test("revoking a key takes the connected agent out of the room", async ({
  request,
  browser,
}) => {
  test.setTimeout(90_000);
  const KEY_NAME = `roomba-${run}`;
  const title = `Keys shared ${run}`;
  // A public note, so a second account can be in the room to watch.
  const noteId = await createNote(request, ALICE, `# ${title}`, "public");
  const { secret } = await mint(request, ALICE, KEY_NAME);

  const context = await browser.newContext({ extraHTTPHeaders: as(BOB) });
  const page = await context.newPage();
  await page.goto("/");
  await page.locator("li").filter({ hasText: title }).first().click();

  const agent = await connectWithSecret(secret);
  try {
    // Reading puts the agent in the note, and the room is told about it.
    await agent.callTool({ name: "read_note", arguments: { id: noteId } });
    const watching = chip(page, "agent is viewing");
    await expect(watching).toBeVisible({ timeout: 8_000 });

    // Other people are told an agent is at work, and never which key it is. A
    // name the owner chose for their own list has no business on anybody else's
    // screen.
    expect(String(await watching.getAttribute("title"))).toContain(ALICE);
    expect(await page.locator("body").textContent()).not.toContain(KEY_NAME);

    const rows = (await (
      await request.get("/api/keys", { headers: as(ALICE) })
    ).json()) as KeyRow[];
    const minted = rows.find((row) => row.name === KEY_NAME);
    expect(minted).toBeDefined();
    expect(
      (
        await request.delete(`/api/keys/${minted?.id}`, { headers: as(ALICE) })
      ).status(),
    ).toBe(204);

    // The room stops showing an agent that has no way back in: revocation reached
    // the session that was already open, rather than only the next handshake.
    await expect(watching).toHaveCount(0, { timeout: 8_000 });

    // And the key is dead, not merely forgotten by this one process.
    await expect(connectWithSecret(secret)).rejects.toThrow();
    expect(
      (
        await request.get(`/api/notes/${noteId}`, {
          headers: { authorization: `Bearer ${secret}` },
        })
      ).status(),
    ).toBe(401);

    // A public note left behind is in everybody's list from here on, including
    // the empty-state assertion a later spec makes.
    expect(
      (
        await request.delete(`/api/notes/${noteId}`, { headers: as(ALICE) })
      ).status(),
    ).toBe(204);
  } finally {
    await agent.close().catch(() => {});
    await context.close();
  }
});
