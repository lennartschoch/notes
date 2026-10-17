import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// The one way this app writes a small JSON file: a sibling temp file renamed
// over the target. Rename is atomic within a filesystem, so a crash mid-write
// can never leave a truncated file behind for a lenient loader to silently
// default — which is what a whole-file store needs to be safe with.
export async function writeJsonAtomically(
  file: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, file);
}

// Reads a JSON file that may not exist yet, or may be cut short. Returning
// undefined rather than throwing is what lets every store say for itself
// whether a missing file means "empty" or "broken".
export async function readJsonFile(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(raw);
}

// One write at a time per file, whatever the order the writes were asked for.
// Every store that mutates an in-memory array and then persists races itself
// otherwise: two writes interleaving their temp file leaves the older snapshot
// on disk.
export function createWriter(): (write: () => Promise<void>) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return (write) => {
    chain = chain.catch(() => {}).then(write);
    return chain;
  };
}
