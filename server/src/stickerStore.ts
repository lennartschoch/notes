import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sticker } from "./types.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const NOTES_DATA_FILE =
  process.env.NOTES_DATA_FILE ?? join(currentDir, "..", "data", "notes.json");

// Stickers live next to the notes file so they share the same persistent
// volume in production (NOTES_DATA_FILE points into /data).
const STICKERS_FILE =
  process.env.STICKERS_DATA_FILE ??
  join(dirname(NOTES_DATA_FILE), "stickers.json");
const STICKERS_DIR =
  process.env.STICKERS_DIR ?? join(dirname(NOTES_DATA_FILE), "stickers");

// Raster formats only: SVG is deliberately excluded because sticker images are
// served inline and an uploaded SVG could carry executable script.
export const STICKER_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

let stickers: Sticker[] = [];
let loaded = false;

let writeChain: Promise<void> = Promise.resolve();

function persist(): Promise<void> {
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(STICKERS_FILE), { recursive: true });
      await writeFile(STICKERS_FILE, JSON.stringify(stickers, null, 2), "utf8");
    });
  return writeChain;
}

function normalize(raw: unknown): Sticker {
  const sticker = (raw ?? {}) as Partial<Sticker>;
  const now = new Date().toISOString();
  return {
    id: typeof sticker.id === "string" ? sticker.id : randomUUID(),
    name: typeof sticker.name === "string" ? sticker.name : "Sticker",
    mime:
      typeof sticker.mime === "string" &&
      Object.hasOwn(STICKER_MIME_EXTENSIONS, sticker.mime)
        ? sticker.mime
        : "image/png",
    owner: typeof sticker.owner === "string" ? sticker.owner : "",
    createdAt: typeof sticker.createdAt === "string" ? sticker.createdAt : now,
  };
}

export async function initStickers(): Promise<void> {
  if (loaded) return;
  await mkdir(STICKERS_DIR, { recursive: true });
  try {
    const raw = await readFile(STICKERS_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    stickers = Array.isArray(parsed) ? parsed.map(normalize) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    stickers = [];
  }
  loaded = true;
}

// Stickers are a shared library: every authenticated user sees all of them.
export function listStickers(): Sticker[] {
  return stickers.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getSticker(id: string): Sticker | undefined {
  return stickers.find((sticker) => sticker.id === id);
}

export function stickerImagePath(sticker: Sticker): string {
  return resolve(
    STICKERS_DIR,
    `${sticker.id}.${STICKER_MIME_EXTENSIONS[sticker.mime]}`,
  );
}

export async function createSticker(
  name: string,
  mime: string,
  base64: string,
  owner: string,
): Promise<Sticker> {
  const sticker: Sticker = {
    id: randomUUID(),
    name: name.trim().slice(0, 60) || "Sticker",
    mime,
    owner,
    createdAt: new Date().toISOString(),
  };
  await mkdir(STICKERS_DIR, { recursive: true });
  await writeFile(stickerImagePath(sticker), Buffer.from(base64, "base64"));
  stickers.push(sticker);
  await persist();
  return sticker;
}

export async function deleteSticker(
  id: string,
  email: string,
): Promise<boolean> {
  const index = stickers.findIndex((sticker) => sticker.id === id);
  if (index === -1) return false;
  const sticker = stickers[index];
  if (sticker.owner !== "" && sticker.owner !== email) return false;
  stickers.splice(index, 1);
  await unlink(stickerImagePath(sticker)).catch(() => {});
  await persist();
  return true;
}
