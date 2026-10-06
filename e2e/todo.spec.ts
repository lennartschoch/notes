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

// The text of each item. Every li also carries a screen-reader label saying
// "Task item checkbox for …", so item text is read from the paragraph inside it.
function itemTexts(page: Page) {
  return editor(page).locator("li p");
}

// Open items only. An archived item sits below its day heading, so the last
// item in the document is the most recently ticked one, not an open one.
function openItemTexts(page: Page) {
  return editor(page).locator("li:not(:has(input:checked)) p");
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

// A to-do list is a list of checkboxes. If the markdown ever stops parsing as
// one, the items come out as bullets whose text is a literal `[ ]`, which is
// easy to miss and impossible to tick.
async function expectCheckboxes(page: Page, total: number, open?: number) {
  await expect(checkboxes(page)).toHaveCount(total);
  if (open !== undefined) {
    await expect(openCheckboxes(page)).toHaveCount(open);
  }
  await expect(editor(page)).not.toContainText("[ ]");
  await expect(editor(page)).not.toContainText("[x]");
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
  await openNoteIn(page, text);
  return page;
}

async function openNoteIn(page: Page, text: string) {
  await noteButton(page, text).click();
  await expect(editor(page)).toBeVisible();
}

async function newNote(page: Page) {
  await page.getByRole("button", { name: "New" }).click();
  await expect(editor(page)).toBeVisible();
}

test("launching an empty note gives a checkbox that survives a reload", async ({
  browser,
}) => {
  const context = await browser.newContext({ extraHTTPHeaders: HEADERS });
  const page = await context.newPage();
  await page.goto("/");
  await newNote(page);

  await launch(page, `Empty ${run}`);

  await expectCheckboxes(page, 1, 1);
  await expect(editor(page).locator("h1")).toHaveText(`Todo · Empty ${run}`);
  await expect(todoButton(page)).toHaveCount(0);

  // The empty item is the fragile one: it is a task marker with nothing after
  // it, so it has to reach the server and come back intact.
  await expect
    .poll(() => savedContent(context, `Todo · Empty ${run}`), {
      timeout: 10_000,
    })
    .toBe(`# Todo · Empty ${run}\n\n- [ ] `);

  await page.reload();
  await openNoteIn(page, `Todo · Empty ${run}`);
  await expectCheckboxes(page, 1, 1);

  // And it can be typed into.
  await itemTexts(page).last().click();
  await page.keyboard.type("buy stamps");
  await expectCheckboxes(page, 1, 1);
  await expect(itemTexts(page).last()).toHaveText("buy stamps");

  await context.close();
});

test("launches a named to-do list from the lines of a note", async ({
  browser,
}) => {
  const context = await browser.newContext({ extraHTTPHeaders: HEADERS });
  const page = await context.newPage();
  await page.goto("/");
  await newNote(page);
  await editor(page).click();
  await page.keyboard.insertText(`milk ${run}\nbread`);

  await launch(page, `Launch ${run}`);

  await expect(editor(page).locator("h1")).toHaveText(`Todo · Launch ${run}`);
  await expectCheckboxes(page, 2, 2);
  await expect(itemTexts(page).first()).toHaveText(`milk ${run}`);
  await expect(itemTexts(page).last()).toHaveText("bread");
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
  await newNote(page);
  await editor(page).click();
  await page.keyboard.insertText(`plain ${run}`);

  await launch(page, null);

  await expect(editor(page).locator("h1")).toHaveCount(0);
  await expect(todoButton(page)).toBeVisible();

  await context.close();
});

test("typing adds items, ticking files them, typing carries on", async ({
  browser,
}) => {
  const context = await browser.newContext({ extraHTTPHeaders: HEADERS });
  const name = `Errands ${run}`;
  const id = await seedNote(context, `# Todo · ${name}\n\n- [ ] buy tape\n`);
  const page = await openNote(context, name);
  await expectCheckboxes(page, 1, 1);

  // A new item on the next line.
  await openItemTexts(page).last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("book a taxi");
  await expectCheckboxes(page, 2, 2);

  // Ticking one files it under today and leaves the other open.
  await checkboxes(page).first().click();
  await expect(editor(page).locator("h2")).toHaveText(TODAY);
  await expectCheckboxes(page, 2, 1);
  // Open items are listed above the day headings, so they come first.
  await expect(itemTexts(page)).toHaveText(["book a taxi", "buy tape"]);
  await expect
    .poll(() => contentOf(context, id), { timeout: 10_000 })
    .toMatch(new RegExp(`## ${TODAY}\\n\\n- \\[x\\] buy tape`));

  // The rewrite that filed the item must not steal the caret: typing straight
  // afterwards continues the item under the cursor, not somewhere else.
  await openItemTexts(page).last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" (blue one)");
  await expect(openItemTexts(page).last()).toHaveText("book a taxi (blue one)");

  // Everything the list remembers, after a reload.
  await page.reload();
  await openNoteIn(page, name);
  await expect(editor(page).locator("h2")).toHaveText(TODAY);
  await expectCheckboxes(page, 2, 1);
  await expect(itemTexts(page)).toHaveText([
    "book a taxi (blue one)",
    "buy tape",
  ]);
  await expect(checkboxes(page).last()).toBeChecked();

  await context.close();
});

test("renaming a list keeps it a to-do list", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: HEADERS });
  const name = `My to-dos ${run}`;
  await seedNote(context, `# Todo · ${name}\n\n- [ ] hang the pictures\n`);
  const page = await openNote(context, name);

  const title = editor(page).locator("h1");
  await title.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(", upstairs");
  await expect(title).toHaveText(`Todo · ${name}, upstairs`);
  await expect(todoButton(page)).toHaveCount(0);

  await checkboxes(page).first().click();
  await expect(editor(page).locator("h2")).toHaveText(TODAY);
  await expectCheckboxes(page, 1, 0);

  await context.close();
});

test("keeps previous days listed newest first", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: HEADERS });
  const name = `House ${run}`;
  await seedNote(
    context,
    `# Todo · ${name}\n\n- [ ] order frames\n\n` +
      `## ${PAST}\n\n- [x] clear the desk\n\n` +
      `## ${OLDER}\n\n- [x] book the dentist\n`,
  );
  const page = await openNote(context, name);
  await expect(editor(page).locator("h2")).toHaveText([PAST, OLDER]);

  await checkboxes(page).first().click();

  await expect(editor(page).locator("h2")).toHaveText([TODAY, PAST, OLDER]);
  await expectCheckboxes(page, 3, 0);
  await expect(
    editor(page).getByText("clear the desk", { exact: true }),
  ).toBeVisible();
  await expect(
    editor(page).getByText("book the dentist", { exact: true }),
  ).toBeVisible();

  await context.close();
});
