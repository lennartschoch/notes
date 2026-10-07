import { test } from "node:test";
import assert from "node:assert/strict";
import type { Note } from "./api";
import { createSyncQueue, type SyncStatus } from "./syncQueue";

// The engine is plain TypeScript, so the only browser surfaces to stub are
// fetch and window.localStorage. Assignments happen before any call, so the
// modules under test never see the real ones.

const storageMap = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, value: string) => void storageMap.set(key, value),
    removeItem: (key: string) => void storageMap.delete(key),
  },
};

interface Recorded {
  method?: string;
  url: string;
  body: { content: string; version: number } | undefined;
}

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: "n1",
    content: "server",
    owner: "dev@localhost",
    visibility: "private",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Installs a fetch stub; each queued responder handles one request, the
// last one repeats. Returns the stub and the recorded requests.
function stubFetch(...responders: { status: number; body?: unknown }[]): {
  requests: Recorded[];
} {
  const state = { index: 0 };
  const requests: Recorded[] = [];
  (globalThis as Record<string, unknown>).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    requests.push({
      method: init?.method,
      url: String(input),
      body: init?.body
        ? (JSON.parse(String(init.body)) as {
            content: string;
            version: number;
          })
        : undefined,
    });
    const responder = responders[Math.min(state.index, responders.length - 1)];
    state.index += 1;
    return {
      ok: responder.status < 400,
      status: responder.status,
      statusText: String(responder.status),
      json: async () => responder.body,
    } as Response;
  };
  return { requests };
}

function collectEvents() {
  const events = {
    saved: [] as { id: string; displayContent: string }[],
    conflicted: [] as string[],
    noteVersion: [] as { id: string; version: number }[],
    gone: [] as string[],
    statuses: [] as SyncStatus[],
  };
  const queue = createSyncQueue({
    saved: (savedNote, displayContent) =>
      events.saved.push({ id: savedNote.id, displayContent }),
    conflicted: (id) => events.conflicted.push(id),
    noteVersion: (id, version) => events.noteVersion.push({ id, version }),
    gone: (id) => events.gone.push(id),
    status: (status) => events.statuses.push(status),
  });
  return { queue, events };
}

function storedRaw(): string | null {
  return storageMap.get("notes.pending-changes.v1") ?? null;
}

test("uploads a scheduled edit and clears it from storage", async () => {
  storageMap.clear();
  const { requests } = stubFetch({ status: 200, body: note({ version: 1 }) });
  const { queue, events } = collectEvents();

  queue.schedule("n1", "hello", 0);
  await queue.flush();

  assert.deepEqual(requests, [
    {
      method: "PUT",
      url: "/api/notes/n1",
      body: { content: "hello", version: 0 },
    },
  ]);
  assert.deepEqual(events.saved, [{ id: "n1", displayContent: "server" }]);
  assert.equal(events.statuses.at(-1), "saved");
  assert.equal(queue.has("n1"), false);
  assert.equal(storedRaw(), null);
});

test("keeps a failed edit queued and in storage", async () => {
  storageMap.clear();
  (globalThis as Record<string, unknown>).fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const { queue, events } = collectEvents();

  queue.schedule("n1", "hello", 0);
  await queue.flush();

  assert.equal(queue.has("n1"), true);
  assert.match(String(storedRaw()), /hello/);
  assert.equal(events.statuses.at(-1), "offline");
});

test("quarantines a 409 and never re-sends the edit", async () => {
  storageMap.clear();
  const server = note({ version: 5, content: "elsewhere" });
  const { requests } = stubFetch(
    { status: 409, body: server },
    { status: 200, body: note() },
  );
  const { queue, events } = collectEvents();

  queue.schedule("n1", "mine", 0);
  await queue.flush();
  await queue.flush();

  assert.equal(requests.length, 1);
  assert.deepEqual(events.conflicted, ["n1"]);
  assert.deepEqual(events.noteVersion, [{ id: "n1", version: 5 }]);
  assert.equal(queue.get("n1")?.status, "conflicted");
  assert.deepEqual(queue.get("n1")?.server, {
    content: "elsewhere",
    version: 5,
  });
});

test("drops the edit when the note is gone on the server", async () => {
  storageMap.clear();
  stubFetch({ status: 404, body: { error: "Note not found" } });
  const { queue, events } = collectEvents();

  queue.schedule("n1", "stale", 0);
  await queue.flush();

  assert.deepEqual(events.gone, ["n1"]);
  assert.equal(queue.has("n1"), false);
  assert.equal(storedRaw(), null);
});

test("rebases an edit queued during an in-flight upload", async () => {
  storageMap.clear();
  let resolveFirst: (value: Response) => void = () => {
    throw new Error("first request never started");
  };
  const requests: Recorded[] = [];
  (globalThis as Record<string, unknown>).fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    requests.push({
      method: init?.method,
      url: String(input),
      body: init?.body
        ? (JSON.parse(String(init.body)) as {
            content: string;
            version: number;
          })
        : undefined,
    });
    if (requests.length === 1) {
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "200",
      json: async () => note({ version: 2 }),
    } as Response);
  };
  const { queue } = collectEvents();

  queue.schedule("n1", "one", 0);
  const flushing = queue.flush();
  await Promise.resolve(); // let flush dispatch the first request
  // A newer edit lands while the first upload is in flight.
  queue.schedule("n1", "two", 0);
  resolveFirst({
    ok: true,
    status: 200,
    statusText: "200",
    json: async () => note({ version: 1, content: "one" }),
  } as Response);
  await flushing;

  // The second upload must not pay for the first one's version bump.
  assert.deepEqual(
    requests.map((r) => r.body?.version),
    [0, 1],
  );
  assert.equal(queue.has("n1"), false);
});
