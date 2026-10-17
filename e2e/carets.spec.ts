import { expect, test, type Page } from "@playwright/test";

const ALICE = { "x-dev-user-email": "alice@test" };
const BOB = { "x-dev-user-email": "bob@test" };

const NOTE_TITLE = "Caret watch note";

function editor(page: Page) {
  return page.locator('[aria-label="Note content"]');
}

function noteItem(page: Page, title: string) {
  return page.locator("li").filter({ hasText: title });
}

function noteButton(page: Page, title: string) {
  return noteItem(page, title).getByRole("button").first();
}

async function appendToNote(page: Page, text: string) {
  const content = editor(page);
  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(text);
}

// The overlay caret a page draws for one peer, identified by the title it
// carries. This is the only place the word appears; the header chip is a
// separate element with a different title.
function caret(page: Page, email: string) {
  return page.locator(`.remote-caret[title*="${email}"]`);
}

test("remote carets follow peers through edits and leave with them", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const aliceContext = await browser.newContext({ extraHTTPHeaders: ALICE });
  const bobContext = await browser.newContext({ extraHTTPHeaders: BOB });
  const alicePage = await aliceContext.newPage();
  const bobPage = await bobContext.newPage();

  try {
    await test.step("both users open a shared note", async () => {
      await alicePage.goto("/");
      await alicePage.getByRole("button", { name: "New" }).click();
      await appendToNote(alicePage, NOTE_TITLE);
      await expect(alicePage.locator('[aria-live="polite"]')).toHaveText(
        "Saved",
      );
      await alicePage
        .getByRole("button", { name: "Private", exact: true })
        .click();

      await bobPage.goto("/");
      await noteButton(bobPage, NOTE_TITLE).click();
      await expect(editor(bobPage)).toContainText(NOTE_TITLE);
    });

    await test.step("opening a note shows each peer where the other sits", async () => {
      await expect(caret(alicePage, "bob@test")).toBeVisible();
      await expect(caret(bobPage, "alice@test")).toBeVisible();
    });

    await test.step("a peer's caret moves as they type", async () => {
      const before = await caret(alicePage, "bob@test").getAttribute("style");
      await appendToNote(bobPage, " typed by bob");
      await expect(caret(alicePage, "bob@test")).not.toHaveAttribute(
        "style",
        before ?? "",
        { timeout: 5_000 },
      );
      const style = await caret(alicePage, "bob@test").getAttribute("style");
      expect(style).toContain("translate(");
    });

    await test.step("a caret survives the remote snapshot rewriting the document", async () => {
      // Alice's edit lands in Bob's editor as a whole-document rewrite; his
      // caret must be relocated by its text anchor, not lost.
      // Wait for Bob's edit to settle into Alice's copy first, so her next
      // keystrokes descend from the same text and do not raise a real
      // same-line conflict against the copy Bob has already saved.
      await expect(editor(alicePage)).toContainText("typed by bob");
      await appendToNote(alicePage, " hello from alice");
      await expect(editor(bobPage)).toContainText("hello from alice");
      await expect(caret(bobPage, "alice@test")).toBeVisible();
    });

    await test.step("a peer leaving clears their caret instead of ghosting it", async () => {
      await bobPage.close();
      await expect(caret(alicePage, "bob@test")).toHaveCount(0);
    });

    await test.step("clean up: deleting the note leaves the store as it was found", async () => {
      // Later specs (multiplayer) start from an empty store.
      alicePage.once("dialog", (dialog) => void dialog.accept());
      await noteItem(alicePage, NOTE_TITLE)
        .getByRole("button", { name: "Delete note" })
        .click();
      await expect(noteItem(alicePage, NOTE_TITLE)).toHaveCount(0);
    });
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
