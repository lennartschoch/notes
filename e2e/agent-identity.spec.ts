import { expect, test, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const port = Number(process.env.E2E_PORT ?? 4100);
const MCP_URL = `http://127.0.0.1:${port}/mcp`;

// The hard case for "tell an agent apart from the user it acts as": the agent
// drives the *same* account the human is signed in with. Nothing may collapse
// the agent into that person — not the self-filter on the presence chip, and not
// the caret identity.
const ALICE = "alice.agent@test";
const run = `${Date.now()}`;

function editor(page: Page) {
  return page.locator('[aria-label="Note content"]');
}

function chip(page: Page, titleSubstring: string) {
  return page.locator(`[title*="${titleSubstring}"]`);
}

// An MCP client that the server treats as an agent (x-dev-agent is honoured only
// while DEV_USERS=1, exactly like the two-identity x-dev-user-email headers).
async function connectAsAgent(email: string): Promise<Client> {
  const client = new Client({ name: "e2e-agent", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { "x-dev-user-email": email, "x-dev-agent": "1" } },
  });
  await client.connect(transport);
  return client;
}

test("an agent acting as your own account shows up as an agent, not as you", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-dev-user-email": ALICE },
  });
  const page = await context.newPage();
  const agent = await connectAsAgent(ALICE);
  try {
    const title = `Agent watch ${run}`;
    await test.step("the human creates and opens a note", async () => {
      await page.goto("/");
      await page.getByRole("button", { name: "New" }).click();
      const content = editor(page);
      await content.click();
      await page.keyboard.insertText(title);
      await expect(page.locator('[aria-live="polite"]')).toHaveText("Saved");
      // Open the note so this tab is a live subscriber in its room.
      await page.locator("li").filter({ hasText: title }).first().click();
      await expect(editor(page)).toContainText(title);
      // Only this one tab is in the room, so no peer chips yet — crucially, no
      // chip for the person's own identity either.
      await expect(chip(page, "is editing")).toHaveCount(0);
      await expect(chip(page, "is viewing")).toHaveCount(0);
    });

    await test.step("an agent editing as that same account shows a distinct chip", async () => {
      await agent.callTool({
        name: "append_to_note",
        arguments: {
          id: await noteIdForTitle(page, title),
          content: " by an agent",
        },
      });
      // The human now sees a chip for "alice.agent@test's agent" editing — even
      // though that is the very account they are signed in as. This is the
      // differentiation the feature is about.
      await expect(
        chip(page, "agent@test\u2019s agent is editing"),
      ).toBeVisible({
        timeout: 5_000,
      });
      // The agent is labelled, never silently presented as the person.
      await expect(chip(page, `${ALICE} is editing`)).toHaveCount(0);
    });

    await test.step("the agent's edit carries an attributed caret", async () => {
      await agent.callTool({
        name: "append_to_note",
        arguments: {
          id: await noteIdForTitle(page, title),
          content: " again",
        },
      });
      await expect(
        page.locator('.remote-caret[data-agent="true"]'),
      ).toBeVisible({ timeout: 5_000 });
    });

    await test.step("whoami reports the agent identity", async () => {
      const who = await agent.callTool({ name: "whoami", arguments: {} });
      const text = JSON.stringify(who);
      expect(text).toContain("AI agent");
    });
  } finally {
    await agent.close();
    await context.close();
  }
});

// The note id printed in the metadata header, read back through the app's own
// list endpoint so the test does not depend on how the agent created the note.
async function noteIdForTitle(page: Page, title: string): Promise<string> {
  const list = await page.request.get("/api/notes", {
    headers: { "x-dev-user-email": ALICE },
  });
  const notes = (await list.json()) as Array<{
    id: string;
    content: string;
  }>;
  const found = notes.find((note) => note.content.includes(title));
  expect(found).toBeDefined();
  return String(found?.id);
}
