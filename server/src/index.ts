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
import {
  createNote,
  deleteNote,
  setNoteVisibility,
  updateNote,
} from "./changes.js";
import { initNotifier } from "./notifier.js";
import { mountMcp } from "./mcp/http.js";
import {
  getVapid,
  initPush,
  removeSubscription,
  upsertSubscription,
} from "./pushStore.js";
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
});
const visibilityBody = z.object({ visibility: z.enum(["private", "public"]) });
const pushSubscriptionBody = z.object({
  endpoint: z.string().regex(/^https?:\/\//i),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
const pushRemovalBody = z.object({ endpoint: z.string().min(1) });

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
app.use(cors());
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
  const note = await createNote(body.content, req.user!.email);
  res.status(201).json(note);
});

app.put("/api/notes/:id", requireUser, async (req, res) => {
  const body = parseBody(updateNoteBody, req, res);
  if (!body) return;
  const result = await updateNote(
    String(req.params.id),
    body.content,
    body.version,
    req.user!.email,
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
    req.user!.email,
  );
  if (!note) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  res.json(note);
});

app.delete("/api/notes/:id", requireUser, async (req, res) => {
  const removed = await deleteNote(String(req.params.id), req.user!.email);
  if (!removed) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  res.status(204).end();
});

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

await init();
await initPush();
initNotifier();
app.listen(PORT, () => {
  console.log(`Notes API listening on http://localhost:${PORT}`);
});
