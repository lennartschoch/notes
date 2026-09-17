import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { requireUser } from "./auth.js";
import { initNotifier, noteRemoved, scheduleNoteChange } from "./notifier.js";
import {
  getVapid,
  initPush,
  removeSubscription,
  upsertSubscription,
} from "./pushStore.js";
import {
  createSticker,
  deleteSticker,
  getSticker,
  initStickers,
  listStickers,
  STICKER_MIME_EXTENSIONS,
  stickerImagePath,
} from "./stickerStore.js";
import {
  createNote,
  deleteNote,
  getNote,
  init,
  listNotes,
  setNoteVisibility,
  updateNote,
} from "./store.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4000);

const app = express();
app.use(cors());
// Sticker uploads carry a base64-encoded image, so they need a larger body
// limit than note edits. Mounting this parser first means the smaller global
// parser below sees the body is already read and skips it.
app.use("/api/stickers", express.json({ limit: "12mb" }));
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
  const content = typeof req.body?.content === "string" ? req.body.content : "";
  const note = await createNote(content, req.user!.email);
  res.status(201).json(note);
});

app.put("/api/notes/:id", requireUser, async (req, res) => {
  const version = req.body?.version;
  if (
    typeof req.body?.content !== "string" ||
    typeof version !== "number" ||
    !Number.isInteger(version)
  ) {
    res
      .status(400)
      .json({ error: "content must be a string and version an integer" });
    return;
  }
  const result = await updateNote(
    String(req.params.id),
    req.body.content,
    version,
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
  // Edits to a public note notify the other users it is shared with, once
  // they settle down (see notifier.ts).
  if (result.note.visibility === "public") {
    scheduleNoteChange(result.note, req.user!.email);
  }
  res.json(result.note);
});

app.patch("/api/notes/:id", requireUser, async (req, res) => {
  const visibility = req.body?.visibility;
  if (visibility !== "private" && visibility !== "public") {
    res.status(400).json({ error: 'visibility must be "private" or "public"' });
    return;
  }
  const note = await setNoteVisibility(
    String(req.params.id),
    visibility,
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
  noteRemoved(String(req.params.id));
  res.status(204).end();
});

// Browser push: the client subscribes through its service worker and registers
// the resulting subscription here, keyed to the signed-in user so notifications
// for a shared note can skip the person who made the edit.
app.get("/api/push/public-key", requireUser, (_req, res) => {
  res.json({ key: getVapid()?.publicKey ?? null });
});

app.put("/api/push/subscription", requireUser, (req, res) => {
  const endpoint =
    typeof req.body?.endpoint === "string" ? req.body.endpoint : "";
  const p256dh =
    typeof req.body?.keys?.p256dh === "string" ? req.body.keys.p256dh : "";
  const auth =
    typeof req.body?.keys?.auth === "string" ? req.body.keys.auth : "";
  if (
    !/^https?:\/\//i.test(endpoint) ||
    p256dh.length === 0 ||
    auth.length === 0
  ) {
    res
      .status(400)
      .json({ error: "endpoint, keys.p256dh and keys.auth are required" });
    return;
  }
  void upsertSubscription(req.user!.email, endpoint, p256dh, auth);
  res.status(204).end();
});

app.delete("/api/push/subscription", requireUser, (req, res) => {
  const endpoint =
    typeof req.body?.endpoint === "string" ? req.body.endpoint : "";
  if (endpoint.length === 0) {
    res.status(400).json({ error: "endpoint is required" });
    return;
  }
  void removeSubscription(endpoint);
  res.status(204).end();
});

// Stickers are a shared library: every authenticated user can list, use and
// embed every sticker. Only the uploader can delete one.
app.get("/api/stickers", requireUser, (_req, res) => {
  res.json(listStickers());
});

app.get("/api/stickers/:id/image", requireUser, (req, res) => {
  const sticker = getSticker(String(req.params.id));
  if (!sticker) {
    res.status(404).json({ error: "Sticker not found" });
    return;
  }
  res.setHeader("Content-Type", sticker.mime);
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  // The path is built server-side from a UUID inside the configured stickers
  // directory, so allow dot-prefixed directory segments (e.g. a data dir such
  // as `.data`); sendFile's default `dotfiles: "ignore"` would 404 them.
  res.sendFile(stickerImagePath(sticker), { dotfiles: "allow" }, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: "Sticker image missing" });
    }
  });
});

app.post("/api/stickers", requireUser, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name : "";
  const mime = typeof req.body?.mime === "string" ? req.body.mime : "";
  const data = typeof req.body?.data === "string" ? req.body.data : "";
  if (!Object.hasOwn(STICKER_MIME_EXTENSIONS, mime)) {
    res.status(400).json({ error: "Unsupported image type" });
    return;
  }
  // Accept either a bare base64 payload or a full data URL.
  const base64 = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
  if (base64.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    res.status(400).json({ error: "data must be base64-encoded image bytes" });
    return;
  }
  const sticker = await createSticker(name, mime, base64, req.user!.email);
  res.status(201).json(sticker);
});

app.delete("/api/stickers/:id", requireUser, async (req, res) => {
  const removed = await deleteSticker(String(req.params.id), req.user!.email);
  if (!removed) {
    res.status(404).json({ error: "Sticker not found" });
    return;
  }
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
await initStickers();
await initPush();
initNotifier();
app.listen(PORT, () => {
  console.log(`Notes API listening on http://localhost:${PORT}`);
});
