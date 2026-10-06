import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// The list is dated with the local day, so the spec writes the same headings
// the app does rather than parsing them back out.
function isoDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

const TODAY = isoDate(new Date());
const PAST = isoDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
const OLDER = isoDate(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));

// One identity for the whole spec, and a marker so this run's notes stay
// findable among the ones other specs leave behind.
const HEADERS = { "x-dev-user-email": "todo@test" };
const run = String(Date.now());

function editor(page: Page) {
  return page.locator('[aria-label="Note content"]');
}

function checkboxes(page: Page) {
  return editor(page).locator('input[type="checkbox"]');
}

function openCheckboxes(page: Page) {
  return editor(page).locator('input[type="checkbox"]:not(:checked)');
}

function noteButton(page: Page, text: string) {
  return page
    .locator("li")
    .filter({ hasText: text })
    .first()
    .getByRole("button")
    .first();
}

async function contentOf(context: BrowserContext, id: string): Promise<string> {
  const response = await context.request.get(`/api/notes/${id}`);
  expect(response.ok()).toBe(true);
  return String((await response.json()).content);
}

// Creates a note straight on the server, for a list that has to start on a day
// other than today.
async function seedNote(
  context: BrowserContext,
  content: string,
): Promise<string> {
  const response = await context.request.post("/api/notes", {
    data: { content },
  });
  expect(response.ok()).toBe(true);
  return String((await response.json()).id);
}

// The saved markdown of the note this spec is working on, found by a phrase
// only it uses.
async function savedContent(
  context: BrowserContext,
  needle: string,
): Promise<string> {
  const response = await context.request.get("/api/notes");
  const notes = (await response.json()) as { id: string; content: string }[];
  return notes.find((note) => note.content.includes(needle))?.content ?? "";
}

async function openNote(context: BrowserContext, text: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/");
  await noteButton(page, text).click();
  await expect(editor(page)).toBeVisible();
  return page;
}

test("launches a to-do list from a note with one click", async ({
  browser,
}) => {
  const context = await browser.newContext({ extraHTTPHeaders: HEADERS });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "New" }).click();
  await editor(page).click();
  await page.keyboard.insertText(`todo launch ${run}\nmilk\nbread`);

  await page.getByRole("button", { name: "To-do list" }).click();

  await expect(editor(page).locator("h1")).toHaveText(`Todo · ${TODAY}`);
  await expect(checkboxes(page)).toHaveCount(3);

  // A note that is already a list no longer offers to become one.
  await expect(page.getByRole("button", { name: "To-do list" })).toHaveCount(0);

  const launched = `todo launch ${run}`;
  await expect
    .poll(() => savedContent(context, launched), { timeout: 10_000 })
    .toContain(`# Todo · ${TODAY}`);
  const content = await savedContent(context, launched);
  expect(content).toContain("- [ ] milk");
  expect(content).toContain("- [ ] bread");

  await context.close();
});

test("ticking an item files it under the day it was ticked", async ({
  browser,
}) => {
  const context = await browser.newContext({ extraHTTPHeaders: HEADERS });
  const id = await seedNote(
    context,
    `# Todo · ${PAST}\n\n- [ ] file taxes ${run}\n- [ ] water plants\n`,
  );
  const page = await openNote(context, `Todo · ${PAST}`);
  await expect(checkboxes(page)).toHaveCount(2);

  await checkboxes(page).first().click();

  // The title moves ahead to the day the tick happened, and the item joins it.
  await expect(editor(page).locator("h1")).toHaveText(`Todo · ${TODAY}`);
  await expect(editor(page).locator("h2")).toHaveText(TODAY);
  await expect(openCheckboxes(page)).toHaveCount(1);
  await expect(checkboxes(page).last()).toBeChecked();

  await expect
    .poll(() => contentOf(context, id), { timeout: 10_000 })
    .toMatch(new RegExp(`## ${TODAY}\\n\\n- \\[x\\] file taxes`));
  const content = await contentOf(context, id);
  expect(content.indexOf("water plants")).toBeLessThan(
    content.indexOf(`## ${TODAY}`),
  );

  // Unticking takes it out of the day and back into the open list, which then
  // has the only thing left to do.
  await checkboxes(page).last().click();
  await expect(editor(page).locator("h2")).toHaveCount(0);
  await expect(openCheckboxes(page)).toHaveCount(2);
  await expect(checkboxes(page)).toHaveCount(2);

  await context.close();
});

test("keeps previous days listed newest first", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: HEADERS });
  await seedNote(
    context,
    `# Todo · ${PAST}\n\n- [ ] order frames ${run}\n\n` +
      `## ${PAST}\n\n- [x] clear the desk\n\n` +
      `## ${OLDER}\n\n- [x] book the dentist\n`,
  );
  const page = await openNote(context, `order frames ${run}`);
  await expect(editor(page).locator("h2")).toHaveText([PAST, OLDER]);

  await checkboxes(page).first().click();

  await expect(editor(page).locator("h1")).toHaveText(`Todo · ${TODAY}`);
  await expect(editor(page).locator("h2")).toHaveText([TODAY, PAST, OLDER]);
  await expect(
    editor(page).getByText("clear the desk", { exact: true }),
  ).toBeVisible();
  await expect(
    editor(page).getByText("book the dentist", { exact: true }),
  ).toBeVisible();

  await context.close();
});
