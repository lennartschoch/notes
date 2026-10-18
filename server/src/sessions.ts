import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createWriter,
  readJsonFile,
  watchJsonFile,
  writeJsonAtomically,
} from "./fileStore.js";

// Signed-in sessions: the app's own answer to "this browser is the person".
//
// A session is a pointer into this file, not a promise carried in a cookie. That
// is the whole reason for it: signing out, changing a password, or deactivating an
// account has to end the sessions it authorised, and a self-contained token
// cannot be taken back — it can only be waited out. It also means the WebSocket
// handshake is authenticated by the same credential as the REST calls, which a
// browser socket cannot send a header over.
//
// Only a hash of the token is kept, so a copied `sessions.json` is a list of
// nothing useful.

const currentDir = dirname(fileURLToPath(import.meta.url));
const NOTES_DATA_FILE =
  process.env.NOTES_DATA_FILE ?? join(currentDir, "..", "data", "notes.json");
const DATA_FILE =
  process.env.SESSIONS_DATA_FILE ??
  join(dirname(NOTES_DATA_FILE), "sessions.json");

// How long a session lives from its last use. Long, because this is a personal
// notes app and the alternative is signing in from a phone every morning; the
// expiry slides, and every way of signing out shortens it to now.
const SESSION_MS =
  Number(process.env.SESSION_HOURS ?? 24 * 30) * 60 * 60 * 1000;

export interface Session {
  id: string;
  email: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  // The user agent that signed in, squashed to one line: which of my sessions is
  // my laptop, and which one is not.
  device: string;
}

export interface StoredSessionShape extends Session {
  hash: string;
}

const sessionSchema = z.object({
  id: z.string().min(1),
  email: z
    .string()
    .min(1)
    .refine((value) => value.includes("@")),
  hash: z.string().min(1),
  createdAt: z.string().catch(() => new Date().toISOString()),
  lastUsedAt: z.string().catch(() => new Date().toISOString()),
  expiresAt: z.string(),
  device: z.string().catch(""),
});

let sessions: StoredSessionShape[] = [];
let loaded = false;
const persist = createWriter();

const now = () => new Date().toISOString();
const expiry = () => new Date(Date.now() + SESSION_MS).toISOString();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function view(session: StoredSessionShape): Session {
  const { hash: _hash, ...rest } = session;
  return rest;
}

// One line, no control characters, short enough to name a device in a list.
export function describeDevice(userAgent: string): string {
  return userAgent.replace(/\s+/g, " ").trim().slice(0, 120);
}

let dropped = false;

function apply(raw: unknown): void {
  const instant = Date.now();
  const before = Array.isArray(raw) ? raw.length : 0;
  sessions = Array.isArray(raw)
    ? raw.flatMap((entry) => {
        const result = sessionSchema.safeParse(entry ?? {});
        if (!result.success) return [];
        const session = result.data as StoredSessionShape;
        // A session that outlived the server it was made on is only a session if it
        // has time left on it.
        if (Date.parse(session.expiresAt) <= instant) return [];
        return [session];
      })
    : [];
  // Anything dropped here is gone from memory and would otherwise sit in the file
  // for as long as this process lived, unnoticed by a sweep that only looks at
  // memory. So the file is brought into line with the answer.
  dropped = sessions.length !== before;
  loaded = true;
}

export async function initSessions(): Promise<void> {
  if (loaded) return;
  await reloadSessions();
}

export async function reloadSessions(): Promise<void> {
  apply(await readJsonFile(DATA_FILE));
  if (dropped) await persist(() => writeJsonAtomically(DATA_FILE, sessions));
}

// The command line ends sessions when it resets or removes an account; without the
// watch, the server would go on accepting them.
export function watchSessions(): void {
  watchJsonFile(DATA_FILE, () => void reloadSessions());
}

export type NewSession = { session: Session; token: string };

// A token that has already been issued to this device is replaced rather than
// added to: two sessions per tab is how a session list becomes unreadable, and
// the old token is dead the moment the browser has the new one.
export async function createSession(
  email: string,
  device: string,
): Promise<NewSession> {
  const same = sessions.filter(
    (session) => session.email === email && session.device === device,
  );
  for (const session of same) sessions.splice(sessions.indexOf(session), 1);
  const token = randomBytes(32).toString("base64url");
  const session: StoredSessionShape = {
    id: randomBytes(8).toString("hex"),
    email,
    hash: hashToken(token),
    createdAt: now(),
    lastUsedAt: now(),
    expiresAt: expiry(),
    device: describeDevice(device),
  };
  sessions.push(session);
  await persist(() => writeJsonAtomically(DATA_FILE, sessions));
  return { session: view(session), token };
}

// The session a cookie points at. Sliding: a session that is past half its life
// starts again, so a person who keeps using the app is never signed out mid-note
// and one who stops is signed out eventually.
export async function sessionForToken(
  token: string,
): Promise<Session | undefined> {
  const hash = hashToken(token);
  const session = sessions.find((entry) => entry.hash === hash);
  if (!session) return undefined;
  const instant = Date.now();
  if (Date.parse(session.expiresAt) <= instant) {
    await remove(session.email, session.id);
    return undefined;
  }
  session.lastUsedAt = new Date(instant).toISOString();
  const fresh =
    Date.parse(session.expiresAt) - instant < SESSION_MS / 2 ? expiry() : null;
  if (fresh) {
    session.expiresAt = fresh;
    await persist(() => writeJsonAtomically(DATA_FILE, sessions));
  }
  return view(session);
}

export function listSessions(email: string): Session[] {
  return sessions
    .filter((session) => session.email === email)
    .map(view)
    .toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

async function remove(email: string, id: string): Promise<boolean> {
  const index = sessions.findIndex(
    (session) => session.email === email && session.id === id,
  );
  if (index === -1) return false;
  sessions.splice(index, 1);
  await persist(() => writeJsonAtomically(DATA_FILE, sessions));
  return true;
}

export async function revokeSession(
  email: string,
  id: string,
): Promise<boolean> {
  return remove(email, id);
}

// Signing out everywhere, and the other half of changing a password. Returns how
// many went, including the caller's own.
export async function revokeSessions(email: string): Promise<number> {
  const before = sessions.length;
  sessions = sessions.filter((session) => session.email !== email);
  await persist(() => writeJsonAtomically(DATA_FILE, sessions));
  return before - sessions.length;
}

// Expired sessions are swept on a timer, so the file does not accumulate the
// history of every browser that ever visited. `nowMs` is the moment to sweep as of,
// which is only ever different from now in a test.
export async function sweepSessions(nowMs = Date.now()): Promise<number> {
  const instant = nowMs;
  const before = sessions.length;
  sessions = sessions.filter(
    (session) => Date.parse(session.expiresAt) > instant,
  );
  if (sessions.length !== before) {
    await persist(() => writeJsonAtomically(DATA_FILE, sessions));
  }
  return before - sessions.length;
}

export const sessionLifetimeMs = SESSION_MS;
