import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// The days a list files items under are local ISO dates, so the spec writes the
// same headings the app does rather than parsing them back out.
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

function todoButton(page: Page) {
  return page.getByRole("button", { name: "To-do list" });
}

function noteButton(page: Page, text: string) {
  return page
    .locator("li")
    .filter({ hasText: text })
    .first()
    .getByRole("button")
    .first();
}

// Launching asks for the list's name once.
async function launch(page: Page, name: string | null) {
  page.once("dialog", (dialog) =>
    name === null ? dialog.dismiss() : dialog.accept(name),
  );
  await todoButton(page).click();
}

async function contentOf(context: BrowserContext, id: string): Promise<string> {
  const response = await context.request.get(`/api/notes/${id}`);
  expect(response.ok()).toBe(true);
  return String((await response.json()).content);
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

// Creates a note straight on the server, for a list that has to start with a
// history or on a day other than today.
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

async function openNote(context: BrowserContext, text: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/");
  await noteButton(page, text).click();
  await expect(editor(page)).toBeVisible();
  return page;
}

test("launches a named to-do list with one click", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: HEADERS });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "New" }).click();
  await editor(page).click();
  await page.keyboard.insertText(`milk ${run}\nbread`);

  await launch(page, `Launch ${run}`);

  await expect(editor(page).locator("h1")).toHaveText(`Todo · Launch ${run}`);
  await expect(checkboxes(page)).toHaveCount(2);

  // A note that is already a list no longer offers to become one.
  await expect(todoButton(page)).toHaveCount(0);

  await expect
    .poll(() => savedContent(context, `milk ${run}`), { timeout: 10_000 })
    .toContain(`# Todo · Launch ${run}`);
  const content = await savedContent(context, `milk ${run}`);
  expect(content).toContain("- [ ] milk");
  expect(content).toContain("- [ ] bread");

  await context.close();
});

test("cancelling the name leaves the note alone", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: HEADERS });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "New" }).click();
  await editor(page).click();
  await page.keyboard.insertText(`plain ${run}`);

  await launch(page, null);

  await expect(editor(page).locator("h1")).toHaveCount(0);
  await expect(todoButton(page)).toBeVisible();

  await context.close();
});

test("ticking an item files it under the day it was ticked", async ({
  browser,
}) => {
  const context = await browser.newContext({ extraHTTPHeaders: HEADERS });
  const id = await seedNote(
    context,
    `# Todo · Chores ${run}\n\n- [ ] file taxes\n- [ ] water plants\n`,
  );
  const page = await openNote(context, `Chores ${run}`);
  await expect(checkboxes(page)).toHaveCount(2);

  await checkboxes(page).first().click();

  // The item joins the day it was ticked on; the name of the list is its own.
  await expect(editor(page).locator("h1")).toHaveText(`Todo · Chores ${run}`);
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

  // Unticking takes it out of the day and back into the open list.
  await checkboxes(page).last().click();
  await expect(editor(page).locator("h2")).toHaveCount(0);
  await expect(openCheckboxes(page)).toHaveCount(2);
  await expect(checkboxes(page)).toHaveCount(2);

  await context.close();
});

test("renaming a list keeps it a to-do list", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: HEADERS });
  await seedNote(
    context,
    `# Todo · My to-dos ${run}\n\n- [ ] hang the pictures\n`,
  );
  const page = await openNote(context, `My to-dos ${run}`);

  const title = editor(page).locator("h1");
  await title.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(", upstairs");
  await expect(title).toHaveText(`Todo · My to-dos ${run}, upstairs`);
  await expect(todoButton(page)).toHaveCount(0);

  await checkboxes(page).first().click();
  await expect(editor(page).locator("h2")).toHaveText(TODAY);
  await expect(checkboxes(page).last()).toBeChecked();

  await context.close();
});

test("keeps previous days listed newest first", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: HEADERS });
  await seedNote(
    context,
    `# Todo · House ${run}\n\n- [ ] order frames\n\n` +
      `## ${PAST}\n\n- [x] clear the desk\n\n` +
      `## ${OLDER}\n\n- [x] book the dentist\n`,
  );
  const page = await openNote(context, `House ${run}`);
  await expect(editor(page).locator("h2")).toHaveText([PAST, OLDER]);

  await checkboxes(page).first().click();

  await expect(editor(page).locator("h2")).toHaveText([TODAY, PAST, OLDER]);
  await expect(
    editor(page).getByText("clear the desk", { exact: true }),
  ).toBeVisible();
  await expect(
    editor(page).getByText("book the dentist", { exact: true }),
  ).toBeVisible();

  await context.close();
});
