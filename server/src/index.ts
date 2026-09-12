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
  if (typeof req.body?.content !== "string") {
    res.status(400).json({ error: "content must be a string" });
    return;
  }
  const note = await updateNote(
    String(req.params.id),
    req.body.content,
    req.user!.email,
  );
  if (!note) {
    res.status(404).json({ error: "Note not found" });
    return;
  }
  res.json(note);
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
app.listen(PORT, () => {
  console.log(`Notes API listening on http://localhost:${PORT}`);
});
