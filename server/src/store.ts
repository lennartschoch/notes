import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Note } from "./types.js";

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

export async function init(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    notes = Array.isArray(parsed) ? (parsed as Note[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    notes = [];
  }
  loaded = true;
}

export function listNotes(): Note[] {
  return notes.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getNote(id: string): Note | undefined {
  return notes.find((note) => note.id === id);
}

export async function createNote(content = ""): Promise<Note> {
  const now = new Date().toISOString();
  const note: Note = {
    id: randomUUID(),
    content,
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
): Promise<Note | undefined> {
  const note = notes.find((n) => n.id === id);
  if (!note) return undefined;
  note.content = content;
  note.updatedAt = new Date().toISOString();
  await persist();
  return note;
}

export async function deleteNote(id: string): Promise<boolean> {
  const index = notes.findIndex((n) => n.id === id);
  if (index === -1) return false;
  notes.splice(index, 1);
  await persist();
  return true;
}
