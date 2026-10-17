import { expect, test, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const port = Number(process.env.E2E_PORT ?? 4100);
const MCP_URL = `http://127.0.0.1:${port}/mcp`;

// The agent acts as the very account the person is signed in as - the hardest
// case there is. Nothing may collapse the two: the person sees a caret and a chip
// for "their own" agent, and the note stays private so no other spec sees it.
const ACCOUNT = "cursor.alice@test";
const HOST = ACCOUNT;
const AGENT = ACCOUNT;
const run = `${Date.now()}`;
const TITLE = `Agent cursor ${run}`;

function editor(page: Page) {
  return page.locator('[aria-label="Note content"]');
}

function chip(page: Page, titleSubstring: string) {
  return page.locator(`[title*="${titleSubstring}"]`);
}

function agentCaret(page: Page) {
  return page.locator('.remote-caret[data-agent="true"]');
}

async function connectAgent(): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const client = new Client({ name: "e2e-cursor", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: {
      headers: { "x-dev-user-email": AGENT, "x-dev-agent": "1" },
    },
  });
  await client.connect(transport);
  return { client, transport };
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

async function notesOf(email: string, page: Page): Promise<NoteRow[]> {
  const list = await page.request.get("/api/notes", {
    headers: { "x-dev-user-email": email },
  });
  return (await list.json()) as NoteRow[];
}

interface NoteRow {
  id: string;
  content: string;
  version: number;
}

async function contentOf(page: Page, id: string): Promise<string> {
  const notes = await notesOf(HOST, page);
  return notes.find((note) => note.id === id)?.content ?? "";
}

test("an agent works in a note with a cursor people can see", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-dev-user-email": HOST },
  });
  const page = await context.newPage();
  const { client, transport } = await connectAgent();

  try {
    let id = "";

    await test.step("the person writes a note with a list in it", async () => {
      const created = await page.request.post("/api/notes", {
        headers: { "x-dev-user-email": HOST },
        data: { content: `# ${TITLE}\n\n- buy milk\n` },
      });
      const note = (await created.json()) as NoteRow;
      id = note.id;
      await page.goto("/");
      await page.locator("li").filter({ hasText: TITLE }).first().click();
      await expect(editor(page)).toContainText("buy milk");
      // The agent acts as this account, so it sees the private note too.
      expect((await notesOf(AGENT, page)).some((row) => row.id === id)).toBe(
        true,
      );
    });

    await test.step("reading is numbered, and shows up as a reader in the room", async () => {
      const read = await call(client, "read_note", { id });
      const text = out(read);
      // The line numbers an agent reads are the ones it can address later.
      expect(text).toContain(`1 | # ${TITLE}`);
      expect(text).toContain("3 | - buy milk");
      expect(text).toMatch(/lines 1-4 of 4/);

      await expect(chip(page, "\u2019s agent is viewing")).toBeVisible();
      await expect(agentCaret(page)).toBeVisible();
      // …and never as the account it acts as.
      await expect(chip(page, `${AGENT} is viewing`)).toHaveCount(0);
    });

    await test.step("typing lands at the caret, and the caret moves there", async () => {
      const before = await agentCaret(page).getAttribute("style");
      const typed = await call(client, "type_in_note", {
        id,
        after: "buy milk",
        text: " and eggs",
      });
      expect(out(typed)).toContain("Saved note");
      expect(await contentOf(page, id)).toContain("- buy milk and eggs");
      await expect(editor(page)).toContainText("buy milk and eggs");
      await expect(chip(page, "\u2019s agent is editing")).toBeVisible();

      const after = await agentCaret(page).getAttribute("style");
      expect(after).toContain("translate(");
      expect(after).not.toEqual(before);
    });

    await test.step("Enter in a list makes the next item, not a bare dash", async () => {
      await call(client, "type_in_note", {
        id,
        text: "\nmop the floor",
      });
      const content = await contentOf(page, id);
      expect(content).toContain("- mop the floor");
      expect(content).not.toMatch(/\n- ?\n/);
      // The caret was carried over from the last edit: no address was needed.
      await expect(editor(page)).toContainText("mop the floor");
    });

    await test.step("a link in handed-over text says where it goes", async () => {
      // Words the agent was given are not formatting: a markdown link arrives as
      // its own words and its own address, so nobody has to hover to check it.
      await call(client, "type_in_note", {
        id,
        paste: "click [here](https://not-the-notes.example) now",
        enterFirst: true,
      });
      expect(await contentOf(page, id)).toContain(
        "click here (https://not-the-notes.example) now",
      );
      await expect(editor(page)).toContainText(
        "here (https://not-the-notes.example)",
      );
      // The editor linkifies a written-out address, which is the point: every
      // address people can click here is labelled with itself.
      const anchors = page.locator('a[href="https://not-the-notes.example"]');
      await expect(anchors).toHaveCount(1);
      await expect(anchors.first()).toHaveText("https://not-the-notes.example");
    });

    await test.step("a stale version is refused, and the retry keeps both edits", async () => {
      // The person is typing in the same note while the agent works. The agent's
      // version is stale, so its write is refused rather than allowed to land on
      // top of the person's - and the retry, addressed by words instead of by a
      // version, lands where those words still are.
      const seen = await notesOf(AGENT, page);
      const version = Number(seen.find((note) => note.id === id)?.version);
      await editor(page).click();
      await page.keyboard.press("Control+Home");
      await page.keyboard.insertText("urgent: ");
      await expect(page.locator('[aria-live="polite"]')).toHaveText("Saved");

      const refused = await call(client, "type_in_note", {
        id,
        after: "buy milk and eggs",
        text: " and a candle",
        version,
      });
      expect(refused.isError).toBe(true);
      expect(out(refused)).toContain("without a version");
      expect(await contentOf(page, id)).not.toContain("and a candle");

      const retry = await call(client, "type_in_note", {
        id,
        after: "buy milk and eggs",
        text: " and a candle",
      });
      expect(retry.isError).not.toBe(true);
      const content = await contentOf(page, id);
      expect(content).toContain("urgent:");
      expect(content).toContain("buy milk and eggs and a candle");
      await expect(editor(page)).toContainText("and a candle");
      await expect(editor(page)).toContainText("urgent:");
    });

    await test.step("a caret the note cannot find any more is not left behind", async () => {
      // Wipe the words the caret is anchored on; the agent's next edit still has
      // to land somewhere in the note rather than fail on a stale position.
      await call(client, "update_note", {
        id,
        content: `# ${TITLE}\n\nrebased\n`,
      });
      const edit = await call(client, "type_in_note", {
        id,
        line: 3,
        text: " typed after the rewrite",
      });
      expect(out(edit)).toContain("Saved note");
      expect(await contentOf(page, id)).toContain("typed after the rewrite");
    });

    await test.step("logging off takes the agent's caret with it", async () => {
      await expect(agentCaret(page)).toBeVisible();
      await transport.terminateSession();
      await expect(agentCaret(page)).toHaveCount(0, { timeout: 5_000 });
      await expect(chip(page, "\u2019s agent")).toHaveCount(0, {
        timeout: 5_000,
      });
    });
  } finally {
    await client.close();
    await context.close();
  }
});
