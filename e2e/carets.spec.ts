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

    await test.step("three simultaneous peers each get their own caret and color", async () => {
      // Charlie joins as a third tab: the overlay must hold more than one
      // caret, and distinguish them by their per-person color.
      const charlieContext = await browser.newContext({
        extraHTTPHeaders: { "x-dev-user-email": "charlie@test" },
      });
      try {
        const charliePage = await charlieContext.newPage();
        await charliePage.goto("/");
        await noteButton(charliePage, NOTE_TITLE).click();
        await expect(
          charliePage.locator('[title*="charlie@test"]'),
        ).toHaveCount(
          0, // no chip or caret for yourself
        );
        await charliePage.locator('[aria-label="Note content"]').click();
        await charliePage.keyboard.insertText(" charlie was here");
        await expect(caret(alicePage, "bob@test")).toBeVisible();
        await expect(caret(alicePage, "charlie@test")).toBeVisible();
        const colors = await alicePage.evaluate(() =>
          [...document.querySelectorAll(".remote-caret")].map(
            (el) => (el as HTMLElement).style.backgroundColor,
          ),
        );
        expect(colors).toHaveLength(2);
        expect(new Set(colors).size).toBe(2);
      } finally {
        await charlieContext.close();
      }
      await expect(caret(alicePage, "charlie@test")).toHaveCount(0);
    });

    await test.step("carets stay glued to their line while the document scrolls", async () => {
      // Make Alice's copy tall enough to scroll inside the editor pane.
      await appendToNote(
        alicePage,
        Array.from({ length: 40 }, (_, i) => `\nfiller line ${i}`).join(""),
      );
      await expect(editor(alicePage)).toContainText("filler line 39");
      await expect(editor(bobPage)).toContainText("filler line 39");
      await expect(caret(alicePage, "bob@test")).toBeVisible();
      const measure = () =>
        alicePage.evaluate(() => {
          const caretEl = document.querySelector(".remote-caret")!;
          const c = caretEl.getBoundingClientRect();
          const lines = [...document.querySelectorAll(".tiptap p")].map((p) => {
            const r = p.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
          });
          const line = lines.findIndex(
            (p) => c.top >= p.top - 3 && c.top <= p.bottom + 3,
          );
          const scroller = caretEl.closest(".overflow-y-auto")!;
          return {
            line,
            scrollTop: scroller.scrollTop,
            caretTop: Math.round(c.top),
          };
        });
      const before = await measure();
      expect(before.line).toBeGreaterThan(-1);
      // Alice just typed at the end, so the scroller may already sit at the
      // bottom: pick a direction with room to move.
      const delta = await alicePage.evaluate(() => {
        const s = document
          .querySelector(".remote-caret")!
          .closest(".overflow-y-auto")!;
        const step = s.scrollTop >= 150 ? -150 : 150;
        s.scrollBy(0, step);
        return step;
      });
      await alicePage.waitForTimeout(400);
      const after = await measure();
      // The overlay lives inside the scrolled content: the caret travels
      // with its text — same line, viewport top shifted by exactly the
      // scroll — instead of drifting over unrelated lines.
      expect(after.scrollTop).toBe(before.scrollTop + delta);
      expect(after.line).toBe(before.line);
      expect(after.caretTop).toBe(before.caretTop - delta);
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

// The relay must not forward nonsense it was handed: positions cannot be
// negative, anchors cannot exceed the protocol's budget, and versions must
// be numbers. Frames can come from any authenticated tab, so the trust
// boundary is the socket, not the app.
test("the live server sanitizes malformed caret frames", async ({
  browser,
  playwright,
  baseURL,
}) => {
  const aliceApi = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: ALICE,
  });
  // A bare context: no identity header, so the socket's ?email= query is
  // what the server reads. A headered context would quietly arrive as that
  // user, and the app itself would publish real carets into the probe note.
  const probeContext = await browser.newContext();
  try {
    const note = await (
      await aliceApi.post("/api/notes", {
        data: { content: "Sanitizer probe note" },
      })
    ).json();
    await aliceApi.patch(`/api/notes/${note.id}`, {
      data: { visibility: "public" },
    });

    const probePage = await probeContext.newPage();
    await probePage.goto(baseURL);
    // Raw sockets from inside a page: this test speaks the wire protocol,
    // not the UI, so the server's validation is under test, not the app's.
    // They connect as charlie: the page's own app (bob) auto-opens the note
    // and publishes its caret into the same room, and its frames are not
    // what this test is about.
    const received = await probePage.evaluate(
      async ([wsBase, noteId]: [string, string]) => {
        const open = () =>
          new Promise<WebSocket>((resolve, reject) => {
            const w = new WebSocket(`${wsBase}/ws?email=charlie@test`);
            w.onopen = () => resolve(w);
            w.onerror = () => reject(new Error("socket error"));
            w.onclose = (e) => reject(new Error(`closed ${e.code}`));
            setTimeout(() => reject(new Error("open timeout")), 5000);
          });
        const spammer = await open();
        const watcher = await open();
        const got: unknown[] = [];
        watcher.onmessage = (e) => {
          const message = JSON.parse(String(e.data));
          if (
            message.type === "cursor" &&
            message.cursor.email === "charlie@test"
          )
            got.push(message.cursor);
        };
        spammer.send(JSON.stringify({ type: "subscribe", noteId }));
        watcher.send(JSON.stringify({ type: "subscribe", noteId }));
        await new Promise((r) => setTimeout(r, 300));
        spammer.send(
          JSON.stringify({
            type: "cursor",
            noteId,
            position: -5,
            anchor: "x".repeat(500),
            version: 1.5,
          }),
        );
        spammer.send(
          JSON.stringify({
            type: "cursor",
            noteId,
            position: 2,
            anchor: "y".repeat(500),
            version: "seven",
          }),
        );
        await new Promise((r) => setTimeout(r, 300));
        spammer.close();
        watcher.close();
        return got;
      },
      [(baseURL ?? "").replace(/^http/, "ws"), note.id] as [string, string],
    );

    const [negative, bogus] = received as [
      { position: number | null; anchor: string; version: number },
      { position: number | null; anchor: string; version: number },
    ];
    // A negative position arrives as a clearing, not as position -5.
    expect(negative.position).toBeNull();
    expect(negative.anchor).toBe("");
    // A non-numeric version falls back to 0, and the oversized anchor is
    // cut to the protocol budget instead of flooding the room.
    expect(bogus.position).toBe(2);
    expect(bogus.version).toBe(0);
    expect(bogus.anchor.length).toBeGreaterThan(0);
    expect(bogus.anchor.length).toBeLessThanOrEqual(24);

    await aliceApi.delete(`/api/notes/${note.id}`);
  } finally {
    await aliceApi.dispose();
    await probeContext.close();
  }
});
