import { expect, test, type APIRequestContext } from "@playwright/test";

const ALICE = { "x-dev-user-email": "alice@test" };
const BOB = { "x-dev-user-email": "bob@test" };

// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

interface Note {
  id: string;
  content: string;
  owner: string;
  visibility: "private" | "public";
  version: number;
}

interface Sticker {
  id: string;
  owner: string;
}

async function createNote(
  api: APIRequestContext,
  content: string,
): Promise<Note> {
  const res = await api.post("/api/notes", { data: { content } });
  expect(res.status()).toBe(201);
  return (await res.json()) as Note;
}

async function createSticker(
  api: APIRequestContext,
  name: string,
): Promise<Sticker> {
  const res = await api.post("/api/stickers", {
    data: { name, mime: "image/png", data: PNG_BASE64 },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as Sticker;
}

test("private notes are invisible and unmanageable to non-owners", async ({
  playwright,
  baseURL,
}) => {
  const alice = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: ALICE,
  });
  const bob = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: BOB,
  });

  try {
    const note = await createNote(alice, "private secret");

    const list = (await (await bob.get("/api/notes")).json()) as Note[];
    expect(list.some((candidate) => candidate.id === note.id)).toBe(false);

    expect((await bob.get(`/api/notes/${note.id}`)).status()).toBe(404);
    expect(
      (
        await bob.put(`/api/notes/${note.id}`, {
          data: { content: "hacked", version: note.version },
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await bob.patch(`/api/notes/${note.id}`, {
          data: { visibility: "public" },
        })
      ).status(),
    ).toBe(404);
    expect((await bob.delete(`/api/notes/${note.id}`)).status()).toBe(404);

    const still = (await (
      await alice.get(`/api/notes/${note.id}`)
    ).json()) as Note;
    expect(still.content).toBe("private secret");
    expect(still.owner).toBe("alice@test");
    expect(still.visibility).toBe("private");
  } finally {
    await alice.dispose();
    await bob.dispose();
  }
});

test("public notes accept non-owner edits but not ownership changes", async ({
  playwright,
  baseURL,
}) => {
  const alice = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: ALICE,
  });
  const bob = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: BOB,
  });

  try {
    const note = await createNote(alice, "public note");
    const published = await alice.patch(`/api/notes/${note.id}`, {
      data: { visibility: "public" },
    });
    expect(published.status()).toBe(200);

    const visible = (await (
      await bob.get(`/api/notes/${note.id}`)
    ).json()) as Note;
    expect(visible.content).toBe("public note");

    const edited = await bob.put(`/api/notes/${note.id}`, {
      data: { content: "bob was here", version: visible.version },
    });
    expect(edited.status()).toBe(200);
    const editedBody = (await edited.json()) as Note;
    expect(editedBody.content).toBe("bob was here");
    expect(editedBody.version).toBe(visible.version + 1);
    // Editing content must not transfer ownership.
    expect(editedBody.owner).toBe("alice@test");

    // A collaborator may edit the content but not change sharing or delete.
    expect(
      (
        await bob.patch(`/api/notes/${note.id}`, {
          data: { visibility: "private" },
        })
      ).status(),
    ).toBe(404);
    expect((await bob.delete(`/api/notes/${note.id}`)).status()).toBe(404);

    const after = (await (
      await alice.get(`/api/notes/${note.id}`)
    ).json()) as Note;
    expect(after.content).toBe("bob was here");
    expect(after.visibility).toBe("public");
    expect(after.owner).toBe("alice@test");
  } finally {
    await alice.dispose();
    await bob.dispose();
  }
});

test("sticker library is shared for use but deletions are owner-only", async ({
  playwright,
  baseURL,
}) => {
  const alice = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: ALICE,
  });
  const bob = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: BOB,
  });

  try {
    const sticker = await createSticker(alice, "alice dot");

    const list = (await (await bob.get("/api/stickers")).json()) as Sticker[];
    expect(list.some((candidate) => candidate.id === sticker.id)).toBe(true);
    expect((await bob.get(`/api/stickers/${sticker.id}/image`)).status()).toBe(
      200,
    );

    // Another user can use the shared sticker but cannot delete it.
    expect((await bob.delete(`/api/stickers/${sticker.id}`)).status()).toBe(
      404,
    );
    expect((await alice.delete(`/api/stickers/${sticker.id}`)).status()).toBe(
      204,
    );
  } finally {
    await alice.dispose();
    await bob.dispose();
  }
});
