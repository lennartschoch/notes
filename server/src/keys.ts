import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { API_KEY_PREFIX } from "./credentials.js";
import {
  createWriter,
  readJsonFile,
  writeJsonAtomically,
} from "./fileStore.js";

// API keys: the app's own machine credential, so an agent can reach the notes
// without Cloudflare Access. A person mints one, names it, and hands it to a
// machine; revoking it is enough to stop that machine, now, without touching
// anybody else's.
//
// Only a hash of a key is stored — a leaked data file does not hand over working
// credentials — and the plaintext is shown exactly once, at creation. The name
// belongs to the account that made the key: it is for the owner's own list and is
// never sent to another user or put in a note, a caret, or a notification.

const currentDir = dirname(fileURLToPath(import.meta.url));
const NOTES_DATA_FILE =
  process.env.NOTES_DATA_FILE ?? join(currentDir, "..", "data", "notes.json");
const DATA_FILE =
  process.env.API_KEYS_DATA_FILE ?? join(dirname(NOTES_DATA_FILE), "keys.json");

export const API_KEY_NAME_MAX = 48;
// Enough for a key per device and per agent, few enough that a forgotten key is
// visible in one screen.
export const MAX_KEYS_PER_ACCOUNT = 20;

interface StoredKey {
  id: string;
  // The account this key acts as — the owner of the key, and of every note the
  // key can reach.
  account: string;
  name: string;
  hash: string;
  // A few characters of the key, kept so a person can tell two keys apart in
  // their list without having stored the thing itself.
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ApiKey extends Omit<StoredKey, "hash"> {}

// A key as it is returned by the one call that makes one: with the secret, which
// exists nowhere else afterwards.
export interface CreatedApiKey extends ApiKey {
  secret: string;
}

const storedKeySchema = z.object({
  id: z
    .string()
    .min(1)
    .catch(() => randomUUID()),
  // A key with no account is a key that grants nobody: dropped rather than
  // defaulted, because there is no safe account to invent.
  account: z.string().min(1),
  name: z.string().min(1).catch("unnamed key"),
  hash: z.string().min(1),
  hint: z.string().catch(""),
  createdAt: z.string().catch(() => new Date().toISOString()),
  lastUsedAt: z.string().nullable().catch(null),
});

let keys: StoredKey[] = [];
let loaded = false;
const persist = createWriter();

// Keys are high-entropy random strings, so they are hashed rather than
// password-hashed: nothing is gained by slowing down an attacker who already has
// the whole secret, and every request would pay the cost. (A person's password,
// when local accounts arrive, is the credential that needs the slow function.)
function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function view(key: StoredKey): ApiKey {
  const { hash: _hash, ...rest } = key;
  return rest;
}

// A name the owner chose, made safe to store: one line, no control characters,
// and short enough that the list stays a list.
export function keyName(input: string): string {
  const cleaned = input.replace(/\s+/g, " ").trim();
  return cleaned.slice(0, API_KEY_NAME_MAX) || "unnamed key";
}

export async function initKeys(): Promise<void> {
  if (loaded) return;
  const parsed = await readJsonFile(DATA_FILE);
  keys = Array.isArray(parsed)
    ? parsed.flatMap((entry) => {
        const result = storedKeySchema.safeParse(entry ?? {});
        if (!result.success) {
          console.warn("keys.json: dropped a record that could not be read");
          return [];
        }
        return [result.data];
      })
    : [];
  loaded = true;
}

function byNewest(a: ApiKey, b: ApiKey): number {
  return b.createdAt.localeCompare(a.createdAt);
}

export function listKeys(account: string): ApiKey[] {
  return keys
    .filter((key) => key.account === account)
    .toSorted(byNewest)
    .map(view);
}

function countKeys(account: string): number {
  return keys.reduce(
    (total, key) => (key.account === account ? total + 1 : total),
    0,
  );
}

export type CreateResult =
  | { status: "ok"; key: CreatedApiKey }
  | { status: "too_many" };

export async function createKey(
  account: string,
  name: string,
): Promise<CreateResult> {
  if (countKeys(account) >= MAX_KEYS_PER_ACCOUNT) return { status: "too_many" };
  const secret = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const key: StoredKey = {
    id: randomUUID(),
    account,
    name: keyName(name),
    hash: hashSecret(secret),
    hint: secret.slice(-6),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  keys.push(key);
  await persist(() => writeJsonAtomically(DATA_FILE, keys));
  return { status: "ok", key: { ...view(key), secret } };
}

// True when the key is gone from the store; a caller that revoked it still has to
// take its live sessions down with it, which is index.ts's business, not this
// file's.
export async function revokeKey(account: string, id: string): Promise<boolean> {
  const index = keys.findIndex(
    (key) => key.account === account && key.id === id,
  );
  if (index === -1) return false;
  keys.splice(index, 1);
  await persist(() => writeJsonAtomically(DATA_FILE, keys));
  return true;
}

export function findKey(account: string, id: string): ApiKey | undefined {
  const key = keys.find(
    (entry) => entry.account === account && entry.id === id,
  );
  return key && key.account.length > 0 ? view(key) : undefined;
}

// The key a presented secret belongs to, or undefined. Constant-time over the
// comparison, so a store of many keys is not a collection of oracle responses.
export async function keyForSecret(
  secret: string,
): Promise<ApiKey | undefined> {
  if (!secret.startsWith(API_KEY_PREFIX)) return undefined;
  const hash = Buffer.from(hashSecret(secret), "hex");
  for (const key of keys) {
    const stored = Buffer.from(key.hash, "hex");
    if (stored.length === hash.length && timingSafeEqual(stored, hash)) {
      return view(key);
    }
  }
  return undefined;
}

// When a key was last used, for the owner's list. Written at most once a minute
// per key: an agent polls, and a whole-file store should not be rewritten for
// every one of those requests.
const LAST_WRITE_MS = 60_000;
const lastWrittenAt = new Map<string, number>();

export async function touchKey(id: string): Promise<void> {
  const now = Date.now();
  if ((lastWrittenAt.get(id) ?? 0) > now - LAST_WRITE_MS) return;
  const key = keys.find((entry) => entry.id === id);
  if (!key) return;
  lastWrittenAt.set(id, now);
  key.lastUsedAt = new Date(now).toISOString();
  await persist(() => writeJsonAtomically(DATA_FILE, keys));
}
