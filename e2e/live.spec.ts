import { expect, test, type Page } from "@playwright/test";

const ALICE = { "x-dev-user-email": "alice@test" };
const BOB = { "x-dev-user-email": "bob@test" };

const NOTE_TITLE = "Live sync note";

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

test("live sync pushes edits, deletions and presence without polling", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const aliceContext = await browser.newContext({ extraHTTPHeaders: ALICE });
  const bobContext = await browser.newContext({ extraHTTPHeaders: BOB });
  const alicePage = await aliceContext.newPage();
  const bobPage = await bobContext.newPage();

  try {
    await test.step("shares a note and both users open it", async () => {
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

    await test.step("shows each user a presence chip for the other", async () => {
      await expect(
        alicePage.locator('[title*="bob@test"]').first(),
      ).toBeVisible();
      await expect(
        bobPage.locator('[title*="alice@test"]').first(),
      ).toBeVisible();
    });

    await test.step("marks a typing peer as editing", async () => {
      await appendToNote(alicePage, " typing by alice");
      await expect(bobPage.locator('[title*="is editing"]')).toBeVisible();
    });

    await test.step("pushes an edit to the other user without a poll", async () => {
      // The periodic refresh runs every 15s; a live push must land well
      // inside this timeout even if neither page is woken or reloaded.
      await appendToNote(alicePage, " hello from alice");
      await expect(editor(bobPage)).toContainText("hello from alice", {
        timeout: 4_000,
      });
    });

    await test.step("conflicts overlapping saves and lets the user keep theirs", async () => {
      // Delay Alice's save so Bob's lands first: both edits rewrote the
      // same (final) line, so this is a real conflict, not a false one.
      let delayed = false;
      await aliceContext.route(/\/api\/notes\/[^/]+$/, async (route) => {
        if (route.request().method() === "PUT" && !delayed) {
          delayed = true;
          await new Promise((resolve) => setTimeout(resolve, 1_500));
        }
        await route.continue();
      });

      await appendToNote(alicePage, " alice wins");
      await appendToNote(bobPage, " bob types too");

      await expect(alicePage.locator('[aria-live="polite"]')).toHaveText(
        "Changed elsewhere",
        { timeout: 10_000 },
      );

      // The explicit override: Alice's text replaces the server copy, and
      // Bob sees the result live instead of stale data.
      await alicePage.getByRole("button", { name: "Keep mine" }).click();
      await expect(alicePage.locator('[aria-live="polite"]')).toHaveText(
        "Saved",
        { timeout: 10_000 },
      );
      await expect(editor(bobPage)).toContainText("alice wins", {
        timeout: 4_000,
      });
      await expect(editor(bobPage)).not.toContainText("bob types too", {
        timeout: 4_000,
      });

      await aliceContext.unroute(/\/api\/notes\/[^/]+$/);
    });

    await test.step("pushes a deletion to the other user without a poll", async () => {
      alicePage.once("dialog", (dialog) => void dialog.accept());
      await noteItem(alicePage, NOTE_TITLE)
        .getByRole("button", { name: "Delete note" })
        .click();
      await expect(noteItem(alicePage, NOTE_TITLE)).toHaveCount(0);
      await expect(noteItem(bobPage, NOTE_TITLE)).toHaveCount(0, {
        timeout: 4_000,
      });
    });
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
