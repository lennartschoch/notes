import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
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

// Content is collaborative: any authenticated user may edit a note they can
// view when it is public, and owners (or legacy unowned notes) can always edit.
// The rule is deliberately identical to canView — seeing a public note and
// editing it are the same grant here — but kept as its own function so a
// future read-only sharing mode has a name to hang off of.
function canEditContent(note: Note, email: string): boolean {
  return canView(note, email);
}

// Managing a note — changing its visibility or deleting it — stays with its
// owner. Public notes are shared for editing, not for ownership changes.
function canManage(note: Note, email: string): boolean {
  return note.owner === "" || note.owner === email;
}

// The shape of a note in the data file. Lenient by design: a field that is
// missing or of the wrong type falls back to its default instead of
// rejecting the note, so a data file written before the field existed - or
// cut short by a crash mid-write - still loads.
const timestamp = () => new Date().toISOString();
const noteRecord = z.object({
  id: z.string().catch(() => randomUUID()),
  content: z.string().catch(""),
  owner: z.string().catch(""),
  visibility: z.enum(["private", "public"]).catch("private"),
  version: z.number().int().catch(0),
  createdAt: z.string().catch(timestamp),
  updatedAt: z.string().catch(timestamp),
});

export async function init(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    notes = Array.isArray(parsed)
      ? parsed.map((raw: unknown) => noteRecord.parse(raw ?? {}))
      : [];
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

// Bypasses the visibility check for system tasks (like notifications) that
// must see a note regardless of who they are running on behalf of.
export function peekNote(id: string): Note | undefined {
  return notes.find((n) => n.id === id);
}

export async function createNote(content = "", owner: string): Promise<Note> {
  const now = new Date().toISOString();
  const note: Note = {
    id: randomUUID(),
    content,
    owner,
    visibility: "private",
    version: 0,
    createdAt: now,
    updatedAt: now,
  };
  notes.push(note);
  await persist();
  return note;
}

export type UpdateResult =
  | { status: "ok"; note: Note }
  | { status: "not_found" }
  | { status: "conflict"; note: Note };

export async function updateNote(
  id: string,
  content: string,
  version: number,
  email: string,
): Promise<UpdateResult> {
  const note = notes.find((n) => n.id === id);
  if (!note || !canEditContent(note, email)) return { status: "not_found" };
  if (note.version !== version) return { status: "conflict", note };
  // Claim a pre-ownership note for the first user to edit it.
  if (note.owner === "") note.owner = email;
  note.content = content;
  note.version += 1;
  note.updatedAt = new Date().toISOString();
  await persist();
  return { status: "ok", note };
}

export async function setNoteVisibility(
  id: string,
  visibility: Visibility,
  email: string,
): Promise<Note | undefined> {
  const note = notes.find((n) => n.id === id);
  if (!note || !canManage(note, email)) return undefined;
  note.visibility = visibility;
  note.updatedAt = new Date().toISOString();
  await persist();
  return note;
}

export async function deleteNote(id: string, email: string): Promise<boolean> {
  const index = notes.findIndex((n) => n.id === id);
  if (index === -1 || !canManage(notes[index], email)) return false;
  notes.splice(index, 1);
  await persist();
  return true;
}
