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
  body: { content: string; version: number; baseContent?: string } | undefined;
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
            baseContent?: string;
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
            baseContent?: string;
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

test("setEvents swaps the handlers the queue reports through", async () => {
  storageMap.clear();
  stubFetch({ status: 200, body: note({ version: 1 }) });
  const seen: string[] = [];
  const queue = createSyncQueue({
    saved: () => {},
    conflicted: () => {},
    noteVersion: () => {},
    gone: () => {},
    status: () => {},
  });
  queue.setEvents({
    saved: (savedNote) => seen.push(savedNote.id),
    conflicted: () => {},
    noteVersion: () => {},
    gone: () => {},
    status: () => {},
  });

  queue.schedule("n1", "hello", 0);
  await queue.flush();

  assert.deepEqual(seen, ["n1"]);
});

test("sends the server text the edit descends from", async () => {
  storageMap.clear();
  const { requests } = stubFetch({ status: 200, body: note({ version: 1 }) });
  const { queue } = collectEvents();

  queue.schedule("n1", "hello", 0, "server");
  await queue.flush();

  assert.deepEqual(requests[0]?.body, {
    content: "hello",
    version: 0,
    baseContent: "server",
  });
});

test("rebasing after a quiet save advances the merge base", async () => {
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
            baseContent?: string;
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

  queue.schedule("n1", "one", 0, "base");
  const flushing = queue.flush();
  await Promise.resolve(); // let flush dispatch the first request
  // A newer edit lands while the first upload is in flight; it descends
  // from the same server text as its predecessor.
  queue.schedule("n1", "two", 0);
  resolveFirst({
    ok: true,
    status: 200,
    statusText: "200",
    json: async () => note({ version: 1, content: "one" }),
  } as Response);
  await flushing;

  // The quiet server took the save as-is, so the ancestor advances to it.
  assert.equal(requests[1]?.body?.baseContent, "one");
});

test("rebasing after a merged save keeps the older ancestor", async () => {
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
            baseContent?: string;
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

  queue.schedule("n1", "two", 0, "base");
  const flushing = queue.flush();
  await Promise.resolve();
  queue.schedule("n1", "three", 0);
  resolveFirst({
    ok: true,
    status: 200,
    statusText: "200",
    // The server merged in someone else's text: the reply is not what was
    // sent. The queued edit still descends from "base", not from this.
    json: async () => note({ version: 1, content: "merged-with-theirs" }),
  } as Response);
  await flushing;

  assert.equal(requests[1]?.body?.baseContent, "base");
  assert.equal(requests[1]?.body?.version, 1);
});

// Reusable gate: every request runs `respond`'s outcome, the first one only
// after the test releases it.
function gatedFetch(first: () => Response, rest: (index: number) => Response) {
  const requests: Recorded[] = [];
  let releaseFirst: (value: Response) => void = () => {
    throw new Error("first request never started");
  };
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
            baseContent?: string;
          })
        : undefined,
    });
    if (requests.length === 1) {
      return new Promise<Response>((resolve) => {
        releaseFirst = resolve;
      });
    }
    return Promise.resolve(rest(requests.length - 1));
  };
  return {
    requests,
    release: () => releaseFirst(first()),
  };
}

const json = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: "200",
    json: async () => body,
  }) as Response;

const failure = (status: number, body: unknown): Response =>
  ({
    ok: false,
    status,
    statusText: String(status),
    json: async () => body,
  }) as Response;

test("a 409 rebases a newer queued edit that knows its ancestor", async () => {
  storageMap.clear();
  const { queue, events } = collectEvents();
  const gate = gatedFetch(
    () => failure(409, note({ version: 5, content: "theirs" })),
    () => json(note({ version: 6, content: "mine+more" })),
  );

  queue.schedule("n1", "mine", 0, "base");
  const flushing = queue.flush();
  await Promise.resolve(); // let flush dispatch the first request
  queue.schedule("n1", "mine+more", 0);
  gate.release();
  await flushing;

  // The newer edit was rebased onto the server's version and merged, not
  // punished twice for the same race and then quarantined.
  assert.deepEqual(requestsBodies(gate.requests), [
    { content: "mine", version: 0, baseContent: "base" },
    { content: "mine+more", version: 5, baseContent: "base" },
  ]);
  assert.deepEqual(events.conflicted, []);
  assert.equal(events.saved.length, 1);
  assert.equal(queue.has("n1"), false);
});

function requestsBodies(requests: Recorded[]) {
  return requests.map((r) => r.body);
}

test("a 409 quarantines a newer queued edit with no known ancestor", async () => {
  storageMap.clear();
  const { queue, events } = collectEvents();
  const gate = gatedFetch(
    () => failure(409, note({ version: 5, content: "theirs" })),
    () => json(note()),
  );

  queue.schedule("n1", "mine", 0);
  const flushing = queue.flush();
  await Promise.resolve();
  queue.schedule("n1", "mine+more", 0);
  gate.release();
  await flushing;

  // Without a merge base a blind retry could clobber, so the newest text
  // is quarantined once — and not re-sent behind the queue's back.
  assert.equal(gate.requests.length, 1);
  assert.deepEqual(events.conflicted, ["n1"]);
  assert.equal(queue.get("n1")?.status, "conflicted");
  assert.equal(queue.get("n1")?.content, "mine+more");
});

test("an edit with an unknown version asks the server before guessing", async () => {
  storageMap.clear();
  const { requests } = stubFetch(
    { status: 200, body: note({ version: 7, content: "server7" }) },
    { status: 200, body: note({ version: 8, content: "hello" }) },
  );
  const { queue } = collectEvents();

  queue.schedule("n1", "hello", null);
  await queue.flush();

  assert.deepEqual(
    requests.map((r) => [r.method ?? "GET", r.url]),
    [
      ["GET", "/api/notes/n1"],
      ["PUT", "/api/notes/n1"],
    ],
  );
  assert.deepEqual(requests[1]?.body, { content: "hello", version: 7 });
});

test("a swallowed flush is re-run once the in-flight flush settles", async () => {
  storageMap.clear();
  const { queue } = collectEvents();
  const gate = gatedFetch(
    () => failure(500, { error: "boom" }),
    () => failure(500, { error: "boom" }),
  );

  queue.schedule("n1", "A", 0);
  const flushing = queue.flush();
  await Promise.resolve();
  // A second note is edited while the first upload is wedged; its debounced
  // flush fires while the first flush is still in flight and is swallowed.
  queue.schedule("n2", "B", 0);
  await new Promise((resolve) => setTimeout(resolve, 900));
  gate.release();
  await flushing;

  // The swallowed flush must still have been honoured by the running loop.
  assert.ok(
    gate.requests.some((r) => r.body?.content === "B"),
    "queued edit B was never attempted after the swallowed flush",
  );
});

test("a conflicted edit counts as unsaved work", async () => {
  storageMap.clear();
  stubFetch({ status: 409, body: note({ version: 5, content: "elsewhere" }) });
  const { queue, events } = collectEvents();

  queue.schedule("n1", "mine", 0);
  await queue.flush();

  assert.equal(queue.hasActive(), true);
  assert.equal(events.statuses.at(-1), "offline");
});

test("resolveConflictKeep re-sends the local text as a deliberate write", async () => {
  storageMap.clear();
  const { requests } = stubFetch(
    { status: 409, body: note({ version: 5, content: "elsewhere" }) },
    { status: 200, body: note({ version: 6, content: "mine" }) },
  );
  const { queue, events } = collectEvents();

  queue.schedule("n1", "mine", 0, "base");
  await queue.flush();
  assert.equal(queue.get("n1")?.status, "conflicted");

  await queue.resolveConflictKeep("n1", 5);

  // The kept edit is aimed at the version the user just confirmed, without
  // a merge base: their text wins over that exact version.
  assert.deepEqual(requests[1]?.body, { content: "mine", version: 5 });
  assert.equal(events.saved.length, 1);
  assert.equal(queue.has("n1"), false);
});
