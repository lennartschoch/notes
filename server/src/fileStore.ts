import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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

// How long a server may go on not knowing. Short enough that whoever ran the
// command sees the app notice it; long enough that it is not a second timer per
// file driving the event loop.
const WATCH_MS = 2000;

// Watching a store another process may have written.
//
// The accounts command line is a second process over the same files, and a server
// holding them in memory would otherwise keep signing people in from a snapshot:
// a password reset, a removed account or an ended session would be written to disk
// and ignored until the next restart. So a store is reloaded when its file moves.
//
// Only the server watches — the command line runs, prints, and leaves.
export function watchJsonFile(
  file: string,
  onLoad: (raw: unknown) => void,
  intervalMs = WATCH_MS,
): void {
  let seen = 0;
  const timer = setInterval(() => {
    void (async () => {
      try {
        const info = await stat(file);
        if (info.mtimeMs === seen) return;
        seen = info.mtimeMs;
        onLoad(await readJsonFile(file));
      } catch {
        // No file yet, or it went away mid-stat: there was nothing in it to learn.
      }
    })();
  }, intervalMs);
  // Do not keep the process alive for the watch alone.
  timer.unref();
}
