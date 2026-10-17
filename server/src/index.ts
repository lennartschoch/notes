import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import { requireUser } from "./auth.js";
import { configureApiKeyStore } from "./credentials.js";
import { corsOptions, allowedOrigins, trustProxySetting } from "./network.js";
import {
  createNote,
  deleteNote,
  setNoteVisibility,
  updateNote,
} from "./changes.js";
import { initNotifier } from "./notifier.js";
import { initLive } from "./ws.js";
import { closeKeySessions } from "./mcp/hub.js";
import { mountMcp } from "./mcp/http.js";
import {
  getVapid,
  initPush,
  removeSubscription,
  upsertSubscription,
} from "./pushStore.js";
import {
  keyForSecret,
  MAX_KEYS_PER_ACCOUNT,
  createKey,
  findKey,
  initKeys,
  listKeys,
  revokeKey,
  touchKey,
} from "./keys.js";
import { getNote, init, listNotes } from "./store.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4000);

// Request bodies, spoken in the same zod the MCP tools and the persisted
// stores use. parseBody writes the 400 and returns undefined when a body
// does not match, so handlers only ever see typed input.
const createNoteBody = z.object({ content: z.string().catch("") });
const updateNoteBody = z.object({
  content: z.string(),
  version: z.number().int(),
  // The text the client's edit descends from. Optional: without it a lost
  // version race stays the plain conflict it always was; with it the server
  // can merge the two divergent edits (see store.ts).
  baseContent: z.string().optional(),
});
const visibilityBody = z.object({ visibility: z.enum(["private", "public"]) });
const pushSubscriptionBody = z.object({
  endpoint: z.string().regex(/^https?:\/\//i),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
const pushRemovalBody = z.object({ endpoint: z.string().min(1) });
// A key's name is for its owner's own list, so an absent or unusable one is
// given a plain default rather than rejected: the thing being created is the
// credential, not the label.
const createKeyBody = z.object({ name: z.string().catch("") });

function parseBody<S extends z.ZodType>(
  schema: S,
  req: Request,
  res: Response,
): z.infer<S> | undefined {
  const parsed = schema.safeParse(req.body ?? {});
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
  res.status(400).json({ error: detail });
  return undefined;
}

const app = express();
// How many hops of X-Forwarded-* to believe, and which browsers may call this
// origin from somewhere else. Both are the operator's to say; both assume the
// safest thing when they do not (see network.ts).
app.set("trust proxy", trustProxySetting());
app.use(cors(corsOptions()));
// MCP endpoint for AI agents (see MCP.md). Mounted before the body parsers so
// the streamable-HTTP transport reads its own JSON-RPC bodies.
mountMcp(app);
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/me", requireUser, (req, res) => {
  res.json({ email: req.user!.email });
});

app.get("/api/notes", requireUser, (req, res) => {
  res.json(listNotes(req.user!.email));
});

app.get("/api/notes/:id", requireUser, (req, res) => {
  const note = getNote(String(req.params.id), req.user!.email);
  if (!note) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  res.json(note);
});

// Express 5 forwards rejected promises from async handlers to the error
// middleware, so no wrapper is needed.
app.post("/api/notes", requireUser, async (req, res) => {
  const body = parseBody(createNoteBody, req, res);
  if (!body) return;
  const note = await createNote(body.content, req.user!);
  res.status(201).json(note);
});

app.put("/api/notes/:id", requireUser, async (req, res) => {
  const body = parseBody(updateNoteBody, req, res);
  if (!body) return;
  const result = await updateNote(
    String(req.params.id),
    body.content,
    body.version,
    req.user!,
    body.baseContent,
  );
  if (result.status === "not_found") {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  if (result.status === "conflict") {
    res.status(409).json(result.note);
    return;
  }
  res.json(result.note);
});

app.patch("/api/notes/:id", requireUser, async (req, res) => {
  const body = parseBody(visibilityBody, req, res);
  if (!body) return;
  const note = await setNoteVisibility(
    String(req.params.id),
    body.visibility,
    req.user!,
  );
  if (!note) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  res.json(note);
});

app.delete("/api/notes/:id", requireUser, async (req, res) => {
  const removed = await deleteNote(String(req.params.id), req.user!);
  if (!removed) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  res.status(204).end();
});

// Minting, listing and revoking keys is something a person does, never something
// a key does. A credential that could hand out credentials would outlive its own
// revocation, and a key's name belongs to its owner — it is not the agent's to
// read back. This is the one place `via` decides anything.
function requireHuman(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.via === "apikey") {
    res.status(403).json({
      error:
        "An API key cannot manage API keys. Do it as the person who owns them.",
    });
    return;
  }
  next();
}

// Browser push: the client subscribes through its service worker and registers
// the resulting subscription here, keyed to the signed-in user so notifications
// for a shared note can skip the person who made the edit.
app.get("/api/push/public-key", requireUser, (_req, res) => {
  res.json({ key: getVapid()?.publicKey ?? null });
});

app.put("/api/push/subscription", requireUser, (req, res) => {
  const body = parseBody(pushSubscriptionBody, req, res);
  if (!body) return;
  void upsertSubscription(
    req.user!.email,
    body.endpoint,
    body.keys.p256dh,
    body.keys.auth,
  );
  res.status(204).end();
});

app.delete("/api/push/subscription", requireUser, (req, res) => {
  const body = parseBody(pushRemovalBody, req, res);
  if (!body) return;
  void removeSubscription(body.endpoint);
  res.status(204).end();
});

// The account's own API keys: the app's machine credential, for an agent that
// has to reach the notes without Cloudflare Access (see MCP.md). The secret comes
// back once, from the call that makes it, and is stored only as a hash.
app.get("/api/keys", requireUser, requireHuman, (req, res) => {
  res.json(listKeys(req.user!.email));
});

app.post("/api/keys", requireUser, requireHuman, async (req, res) => {
  const body = parseBody(createKeyBody, req, res);
  if (!body) return;
  const result = await createKey(req.user!.email, body.name);
  if (result.status === "too_many") {
    res.status(409).json({
      error: `Too many API keys for one account (${MAX_KEYS_PER_ACCOUNT}). Revoke one first.`,
    });
    return;
  }
  const { secret, ...key } = result.key;
  console.log(`API key \u201c${key.name}\u201d created for ${req.user!.email}`);
  res.status(201).json({ key, secret });
});

app.delete("/api/keys/:id", requireUser, requireHuman, async (req, res) => {
  const email = req.user!.email;
  const id = String(req.params.id);
  const name = findKey(email, id)?.name;
  if (!(await revokeKey(email, id))) {
    res.status(404).json({ error: "API key not found" });
    return;
  }
  // Revoking has to reach the agent that is already connected, not only the next
  // handshake it makes.
  const closed = await closeKeySessions(id);
  console.log(
    `API key \u201c${name ?? id}\u201d revoked for ${email}${
      closed > 0
        ? ` (${closed} live session${closed === 1 ? "" : "s"} closed)`
        : ""
    }`,
  );
  res.status(204).end();
});

// Registered after every API route, so an unknown one cannot be mistaken for the
// SPA's own path and answered with index.html.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const clientDist = join(currentDir, "..", "..", "client", "dist");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // Express 5 uses path-to-regexp v8: `*` is no longer a valid path and a
  // wildcard must be named (`/*splat`).
  app.get("/*splat", (_req, res) => {
    res.sendFile(join(clientDist, "index.html"));
  });
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

// The identity chain answers for this app's own keys; the store that says which
// ones exist is handed to it here, at the app's entrance, so deciding who a
// caller is never has to know where the hashes are kept.
configureApiKeyStore({ lookup: keyForSecret, used: touchKey });

await init();
await initKeys();
await initPush();
initNotifier();
const httpServer = app.listen(PORT, () => {
  console.log(`Notes API listening on http://localhost:${PORT}`);
  // The two things about the network this app cannot know for itself, printed so
  // a deployment that got one wrong finds out now rather than through a browser.
  const origins = allowedOrigins();
  const proxy = trustProxySetting();
  console.log(
    `  browsers: ${
      origins.length > 0
        ? `cross-origin calls allowed from ${origins.join(", ")}`
        : "same-origin only"
    }; proxy: ${
      proxy === false
        ? "not trusted (set TRUST_PROXY behind a reverse proxy)"
        : `trusted (${String(proxy)})`
    }`,
  );
});
// Live sync: the /ws upgrade rides the same HTTP server (and the same
// Cloudflare Access identity) as the REST API.
initLive(httpServer);
