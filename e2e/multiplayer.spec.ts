import { expect, test, type Page } from "@playwright/test";

const ALICE = { "x-dev-user-email": "alice@test" };
const BOB = { "x-dev-user-email": "bob@test" };

const PRIVATE_NOTE = "Alice private alpha";
const PUBLIC_NOTE = "Alice public bravo";
const RAPID_NOTE = "Alice rapid note";
const ALICE_EDIT = "plus alice edit";
const BOB_EDIT = "plus bob edit";
const DEVICE_TWO_EDIT = "device two edit";
const SAVE_DEBOUNCE_MS = 800;

interface Note {
  id: string;
  content: string;
  version: number;
  visibility: "private" | "public";
}

function status(page: Page) {
  return page.locator('[aria-live="polite"]');
}

function editor(page: Page) {
  return page.locator('[aria-label="Note content"]');
}

function noteItem(page: Page, title: string) {
  return page.locator("li").filter({ hasText: title });
}

function noteButton(page: Page, title: string) {
  return noteItem(page, title).getByRole("button").first();
}

// The app refreshes on window focus and tab visibility; dispatch both so a
// "second device" pulls the latest state immediately instead of waiting for the
// periodic poll.
async function wake(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function appendToNote(page: Page, text: string) {
  const content = editor(page);
  await content.click();
  await page.keyboard.press("Control+End");
  // Rich-text (ProseMirror) re-renders on every keystroke; injecting the whole
  // string as one input event avoids racing the editor's caret position.
  await page.keyboard.insertText(text);
}

test("multiplayer note lifecycle", async ({ browser, playwright, baseURL }) => {
  const aliceContext = await browser.newContext({ extraHTTPHeaders: ALICE });
  const deviceTwoContext = await browser.newContext({
    extraHTTPHeaders: ALICE,
  });
  const bobContext = await browser.newContext({ extraHTTPHeaders: BOB });
  const alicePage = await aliceContext.newPage();
  const deviceTwoPage = await deviceTwoContext.newPage();
  const bobPage = await bobContext.newPage();
  const aliceApi = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: ALICE,
  });

  let publicNoteId = "";
  let versionAtDeviceTwo = 0;

  try {
    await test.step("creates a private note that persists across reloads", async () => {
      await alicePage.goto("/");
      await expect(alicePage.getByText("No notes yet")).toBeVisible();
      await bobPage.goto("/");
      await expect(bobPage.getByText("No notes yet")).toBeVisible();

      await alicePage.getByRole("button", { name: "New" }).click();
      await expect(editor(alicePage)).toBeVisible();
      await appendToNote(alicePage, PRIVATE_NOTE);
      await expect(status(alicePage)).toHaveText("Saved");

      await alicePage.reload();
      await expect(noteButton(alicePage, PRIVATE_NOTE)).toBeVisible();
      await expect(editor(alicePage)).toContainText(PRIVATE_NOTE);
    });

    await test.step("keeps a private note hidden from another user", async () => {
      await wake(bobPage);
      await expect(noteItem(bobPage, PRIVATE_NOTE)).toHaveCount(0);
      await expect(bobPage.getByText("No notes yet")).toBeVisible();
    });

    await test.step("shares a public note with the other user", async () => {
      await alicePage.getByRole("button", { name: "New" }).click();
      await appendToNote(alicePage, PUBLIC_NOTE);
      await expect(status(alicePage)).toHaveText("Saved");

      await alicePage
        .getByRole("button", { name: "Private", exact: true })
        .click();
      await expect(
        alicePage.getByRole("button", { name: "Public", exact: true }),
      ).toBeVisible();

      await wake(bobPage);
      await expect(noteButton(bobPage, PUBLIC_NOTE)).toBeVisible();
      await expect(noteItem(bobPage, PRIVATE_NOTE)).toHaveCount(0);
      await expect(noteItem(bobPage, PUBLIC_NOTE)).toBeVisible();
    });

    await test.step("propagates one user's edit to another user's open view", async () => {
      await noteButton(bobPage, PUBLIC_NOTE).click();
      await expect(editor(bobPage)).toContainText(PUBLIC_NOTE);

      await noteButton(alicePage, PUBLIC_NOTE).click();
      await appendToNote(alicePage, ALICE_EDIT);
      await expect(status(alicePage)).toHaveText("Saved");

      await wake(bobPage);
      await expect(editor(bobPage)).toContainText(ALICE_EDIT);
    });

    await test.step("persists an edit made by a non-owner of a public note", async () => {
      await expect(editor(bobPage)).toBeVisible();
      await appendToNote(bobPage, ` ${BOB_EDIT}`);
      await expect(status(bobPage)).toHaveText("Saved");
      await expect(editor(bobPage)).toContainText(BOB_EDIT);

      // A non-owner may edit a public note's content but must not be able to
      // change sharing, so the visibility control stays disabled.
      await expect(
        bobPage.getByRole("button", { name: "Public", exact: true }),
      ).toBeDisabled();

      // The edit must survive a reload, not be silently dropped as if the note
      // had been deleted (the non-owner write used to 404 on the server).
      await bobPage.reload();
      await noteButton(bobPage, PUBLIC_NOTE).click();
      await expect(editor(bobPage)).toContainText(BOB_EDIT);
      await expect(editor(bobPage)).toContainText(ALICE_EDIT);
    });

    await test.step("quarantines a conflicting save instead of overwriting", async () => {
      await deviceTwoPage.goto("/");
      await wake(deviceTwoPage);
      await noteButton(deviceTwoPage, PUBLIC_NOTE).click();
      await expect(editor(deviceTwoPage)).toContainText(ALICE_EDIT);

      const list = (await (await aliceApi.get("/api/notes")).json()) as Note[];
      const note = list.find((candidate) =>
        candidate.content.includes(PUBLIC_NOTE),
      );
      if (!note) throw new Error("public note not found via API");
      publicNoteId = note.id;
      versionAtDeviceTwo = note.version;

      // Freeze device two's base version by blocking list refreshes, then move
      // the server forward from "device one". Device two's next save is now
      // guaranteed to carry a stale version.
      await deviceTwoContext.route(/\/api\/notes$/, (route) => route.abort());
      const bumped = await aliceApi.put(`/api/notes/${publicNoteId}`, {
        data: { content: "server side change", version: versionAtDeviceTwo },
      });
      expect(bumped.ok()).toBeTruthy();

      await appendToNote(deviceTwoPage, ` ${DEVICE_TWO_EDIT}`);
      await expect(status(deviceTwoPage)).toHaveText("Changed elsewhere");
      await expect(
        noteItem(deviceTwoPage, PUBLIC_NOTE).locator(
          "svg.lucide-triangle-alert",
        ),
      ).toBeVisible();

      // The local edit is preserved and visible, nothing vanishes.
      await expect(editor(deviceTwoPage)).toContainText(DEVICE_TWO_EDIT);

      // The server copy was never overwritten by the stale save.
      const after = (await (
        await aliceApi.get(`/api/notes/${publicNoteId}`)
      ).json()) as Note;
      expect(after.content).toBe("server side change");
      expect(after.version).toBe(versionAtDeviceTwo + 1);
    });

    await test.step("does not clobber a quarantined edit when refreshing", async () => {
      await deviceTwoContext.unroute(/\/api\/notes$/);

      const bumped = await aliceApi.put(`/api/notes/${publicNoteId}`, {
        data: { content: "even newer server", version: versionAtDeviceTwo + 1 },
      });
      expect(bumped.ok()).toBeTruthy();

      await wake(deviceTwoPage);
      await expect(editor(deviceTwoPage)).toContainText(DEVICE_TWO_EDIT);
      await expect(editor(deviceTwoPage)).not.toContainText(
        "even newer server",
      );
    });

    await test.step("resolves the conflict by loading the server version", async () => {
      deviceTwoPage.once("dialog", (dialog) => {
        expect(dialog.type()).toBe("confirm");
        void dialog.accept();
      });
      await noteButton(deviceTwoPage, PUBLIC_NOTE).click();

      await expect(editor(deviceTwoPage)).toContainText("even newer server");
      await expect(editor(deviceTwoPage)).not.toContainText(DEVICE_TWO_EDIT);
      await expect(status(deviceTwoPage)).not.toHaveText("Changed elsewhere");
      await expect(
        noteItem(deviceTwoPage, PUBLIC_NOTE).locator(
          "svg.lucide-triangle-alert",
        ),
      ).toHaveCount(0);
    });

    await test.step("propagates deletion to the other user", async () => {
      alicePage.once("dialog", (dialog) => void dialog.accept());
      await noteItem(alicePage, PUBLIC_NOTE)
        .getByRole("button", { name: "Delete note" })
        .click();
      await expect(noteItem(alicePage, PUBLIC_NOTE)).toHaveCount(0);

      await wake(bobPage);
      await expect(noteItem(bobPage, PUBLIC_NOTE)).toHaveCount(0);
    });

    await test.step("does not falsely quarantine a rapid second edit", async () => {
      await alicePage.getByRole("button", { name: "New" }).click();
      await appendToNote(alicePage, RAPID_NOTE);
      await expect(status(alicePage)).toHaveText("Saved");

      // Delay the first PUT so the next keystroke is queued while it is still
      // in flight — the exact race that used to capture a stale base version.
      let delayed = false;
      await aliceContext.route(/\/api\/notes\/[^/]+$/, async (route) => {
        if (route.request().method() === "PUT" && !delayed) {
          delayed = true;
          await new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS));
        }
        await route.continue();
      });

      await appendToNote(alicePage, " one");
      await alicePage.waitForTimeout(SAVE_DEBOUNCE_MS + 200);
      await appendToNote(alicePage, " two");

      await expect(status(alicePage)).toHaveText("Saved");
      await expect(status(alicePage)).not.toHaveText("Changed elsewhere");
      await expect(editor(alicePage)).toContainText("one two");

      await aliceContext.unroute(/\/api\/notes\/[^/]+$/);
    });
  } finally {
    await aliceApi.dispose();
    await aliceContext.close();
    await deviceTwoContext.close();
    await bobContext.close();
  }
});
