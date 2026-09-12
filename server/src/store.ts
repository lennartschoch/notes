import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Note, Visibility } from "./types.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const DATA_FILE =
  process.env.NOTES_DATA_FILE ?? join(currentDir, "..", "data", "notes.json");

let notes: Note[] = [];
let loaded = false;

let writeChain: Promise<void> = Promise.resolve();

function persist(): Promise<void> {
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(DATA_FILE), { recursive: true });
      await writeFile(DATA_FILE, JSON.stringify(notes, null, 2), "utf8");
    });
  return writeChain;
}

// A note is visible to its owner, to everyone when public, and to everyone
// when unowned (notes written before ownership existed). Owners are emails
// taken from the verified Cloudflare Access token.
function canView(note: Note, email: string): boolean {
  return (
    note.visibility === "public" || note.owner === "" || note.owner === email
  );
}

function canEdit(note: Note, email: string): boolean {
  return note.owner === "" || note.owner === email;
}

// Fills in fields added after the first release so an old data file keeps
// loading. Unowned notes stay unowned (shared with every authenticated user).
function normalize(raw: unknown): Note {
  const note = (raw ?? {}) as Partial<Note>;
  const now = new Date().toISOString();
  return {
    id: typeof note.id === "string" ? note.id : randomUUID(),
    content: typeof note.content === "string" ? note.content : "",
    owner: typeof note.owner === "string" ? note.owner : "",
    visibility: note.visibility === "public" ? "public" : "private",
    createdAt: typeof note.createdAt === "string" ? note.createdAt : now,
    updatedAt: typeof note.updatedAt === "string" ? note.updatedAt : now,
  };
}

export async function init(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    notes = Array.isArray(parsed) ? parsed.map(normalize) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    notes = [];
  }
  loaded = true;
}

export function listNotes(email: string): Note[] {
  return notes
    .filter((note) => canView(note, email))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getNote(id: string, email: string): Note | undefined {
  const note = notes.find((n) => n.id === id);
  return note && canView(note, email) ? note : undefined;
}

export async function createNote(content = "", owner: string): Promise<Note> {
  const now = new Date().toISOString();
  const note: Note = {
    id: randomUUID(),
    content,
    owner,
    visibility: "private",
    createdAt: now,
    updatedAt: now,
  };
  notes.push(note);
  await persist();
  return note;
}

export async function updateNote(
  id: string,
  content: string,
  email: string,
): Promise<Note | undefined> {
  const note = notes.find((n) => n.id === id);
  if (!note || !canEdit(note, email)) return undefined;
  // Claim a pre-ownership note for the first user to edit it.
  if (note.owner === "") note.owner = email;
  note.content = content;
  note.updatedAt = new Date().toISOString();
  await persist();
  return note;
}

export async function setNoteVisibility(
  id: string,
  visibility: Visibility,
  email: string,
): Promise<Note | undefined> {
  const note = notes.find((n) => n.id === id);
  if (!note || !canEdit(note, email)) return undefined;
  note.visibility = visibility;
  note.updatedAt = new Date().toISOString();
  await persist();
  return note;
}

export async function deleteNote(id: string, email: string): Promise<boolean> {
  const index = notes.findIndex((n) => n.id === id);
  if (index === -1 || !canEdit(notes[index], email)) return false;
  notes.splice(index, 1);
  await persist();
  return true;
}
