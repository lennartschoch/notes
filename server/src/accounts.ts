import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from "./password.js";
import {
  createWriter,
  readJsonFile,
  watchJsonFile,
  writeJsonAtomically,
} from "./fileStore.js";

// Accounts with passwords: the credential this app can offer a person when
// Cloudflare Access is not in front of it.
//
// Notes are owned by an email address, so an account *is* an email address — the
// same one Access put in a note's `owner`, which is why signing in locally reaches
// the notes a person arrived at through Access.
//
// Accounts are made on the command line (`npm run accounts -w server -- add …`),
// not by a signup form: a self-hosted notes app has no mail server to verify an
// address with, and a form that lets anybody make an account on a private
// installation is a worse version of the policy Access already gave it.

const currentDir = dirname(fileURLToPath(import.meta.url));
const NOTES_DATA_FILE =
  process.env.NOTES_DATA_FILE ?? join(currentDir, "..", "data", "notes.json");
const DATA_FILE =
  process.env.ACCOUNTS_DATA_FILE ??
  join(dirname(NOTES_DATA_FILE), "accounts.json");

// How a person came to have an account. A self-hosted notes app has no signup
// page, so the ordinary answer is the command line — the same job an Access policy
// does for a hosted deployment. The other names are here so a record made some
// other way does not read as a mistake.
export type AccountSource = "cli" | "imported" | "access";

export interface AccountUsage {
  signedInAt: string | null;
  signedInFrom: string | null;
}

export interface Account {
  email: string;
  name: string;
  active: boolean;
  createdAt: string;
  createdBy: AccountSource;
  usage: AccountUsage;
}

export interface StoredAccountShape extends Account {
  hash: string;
}

export const ACCOUNT_NAME_MAX = 48;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 512;
// Enough entropy that a printed one-time password is not a formality, and short
// enough that it survives being typed on a phone.
const ONE_TIME_PASSWORD_BYTES = 12;

// A name is a courtesy, not an identity: the email owns the notes. One line, no
// control characters, short enough that a header does not wrap.
export function accountName(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, ACCOUNT_NAME_MAX);
}

export function normaliseEmail(input: string): string {
  return input.trim().toLowerCase();
}

// The one shape this app accepts as an account address. Deliberately not an RFC:
// this check exists so a typo cannot become the owner of somebody's notes, and a
// real parser would only ever disagree about addresses nobody means.
const EMAIL = /^[^\s@,;:<>"()[\\\]]+@[^\s@,;:<>"()[\\\]]+/;

export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

// What a person types as their password, judged only on being a password. There
// is no composition rule, because a length rule is the only one people can meet
// from memory, and a maximum exists so that pasting a novel does not become a
// hash.
export function passwordProblem(password: string): string {
  if (password.length < PASSWORD_MIN) {
    return `Use at least ${PASSWORD_MIN} characters.`;
  }
  if (password.length > PASSWORD_MAX) {
    return `Use no more than ${PASSWORD_MAX} characters.`;
  }
  return "";
}

// A password this app made up, for the first account and for `passwd --print`.
// Spoken in five chunks, which is what a one-time password has to be to survive
// being read out loud or typed once.
export function temporaryPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(ONE_TIME_PASSWORD_BYTES);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out.match(/.{4}/g)!.join("-");
}

const usageSchema = z.object({
  signedInAt: z.string().nullable().catch(null),
  signedInFrom: z.string().nullable().catch(null),
});

const accountSchema = z.object({
  // An account whose address cannot be read is not an account: the email is the
  // primary key of every note in the app, so there is nothing to default it to.
  email: z.string().refine(isEmail),
  name: z.string().catch(""),
  hash: z.string().min(1),
  active: z.boolean().catch(true),
  createdAt: z.string().catch(() => new Date().toISOString()),
  createdBy: z
    .enum(["cli", "imported", "access"])
    .catch("imported" as AccountSource),
  usage: usageSchema.catch({ signedInAt: null, signedInFrom: null }),
});

let accounts: StoredAccountShape[] = [];
let loaded = false;
const persist = createWriter();

const now = () => new Date().toISOString();

// Whatever is in the file, read as far as it will go.
function apply(raw: unknown): void {
  accounts = Array.isArray(raw)
    ? raw.flatMap((entry) => {
        const result = accountSchema.safeParse(entry ?? {});
        if (!result.success) {
          // Dropped rather than repaired: there is no address to invent for a
          // note owner, and a silently defaulted one would own notes nobody
          // signed in as.
          console.warn(
            "accounts.json: dropped a record whose address or hash could not be read",
          );
          return [];
        }
        return [result.data as StoredAccountShape];
      })
    : [];
  loaded = true;
}

export async function initAccounts(): Promise<void> {
  if (loaded) return;
  await reloadAccounts();
}

// Read the file again, after something else moved it.
export async function reloadAccounts(): Promise<void> {
  apply(await readJsonFile(DATA_FILE));
}

// Called by the server only: the command line is the other writer of this file.
export function watchAccounts(): void {
  watchJsonFile(DATA_FILE, () => void reloadAccounts());
}

function find(email: string): StoredAccountShape | undefined {
  const wanted = normaliseEmail(email);
  return accounts.find((account) => account.email === wanted);
}

async function save(): Promise<void> {
  await persist(() => writeJsonAtomically(DATA_FILE, accounts));
}

export function accountCount(): number {
  return accounts.filter((account) => account.active).length;
}

export function hasAccounts(): boolean {
  return accountCount() > 0;
}

export function listAccounts(): Account[] {
  return accounts
    .map(({ hash: _hash, ...account }) => account)
    .toSorted((a, b) => a.email.localeCompare(b.email));
}

export type CreateResult =
  | { status: "ok"; email: string; password: string }
  | { status: "exists" }
  | { status: "weak"; problem: string };

// Making an account. `password` empty means "make one up and print it", which is
// the shape of the first sign-in on a machine nobody has set a password on yet.
export async function createAccount(
  email: string,
  password: string,
  name = "",
  source: AccountSource = "cli",
): Promise<CreateResult> {
  const address = normaliseEmail(email);
  if (!isEmail(address)) throw new Error(`not an email address: "${email}"`);
  if (find(address)) return { status: "exists" };
  const secret = password.length > 0 ? password : temporaryPassword();
  const problem = passwordProblem(secret);
  if (problem.length > 0) return { status: "weak", problem };
  accounts.push({
    email: address,
    name: accountName(name),
    hash: await hashPassword(secret),
    active: true,
    createdAt: now(),
    createdBy: source,
    usage: { signedInAt: null, signedInFrom: null },
  });
  await save();
  return { status: "ok", email: address, password: secret };
}

export type SignInResult =
  | { status: "ok"; email: string }
  // One answer for "there is no such account" and "wrong password": a login form
  // that distinguishes them is a list of who has an account here, which is the
  // first thing anybody collects before guessing at a password.
  | { status: "denied" }
  | { status: "inactive" };

// The only place a password is ever compared, so a caller cannot accidentally
// answer "no such account" and "wrong password" differently. When it does not
// match, a hash is still computed against a stand-in salt: the difference between
// a person who has an account and a person who does not is otherwise a way to ask
// the login form who is registered.
export async function signIn(
  email: string,
  password: string,
): Promise<SignInResult> {
  const account = find(email);
  const hash = account?.hash ?? (await placeholderHash());
  const matches = await verifyPassword(password, hash);
  if (!account || !matches) return { status: "denied" };
  if (!account.active) return { status: "inactive" };
  // The cost of hashing is this build's to raise; the person who knows the
  // password is the one who should not have to notice.
  if (passwordNeedsRehash(hash)) {
    account.hash = await hashPassword(password);
    await save();
  }
  return { status: "ok", email: account.email };
}

// A hash of a value nobody can sign in with, checked against a sign-in for an
// address that does not exist — so "wrong password" and "nobody here by that
// name" take the same time as well as giving the same answer. Made on first use,
// so it is not a constant an attacker prepared in advance.
let placeholder: string | undefined;

async function placeholderHash(): Promise<string> {
  placeholder ??= await hashPassword(temporaryPassword());
  return placeholder;
}

export async function setPassword(
  email: string,
  password: string,
): Promise<boolean> {
  const account = find(email);
  if (!account) return false;
  if (passwordProblem(password).length > 0) return false;
  account.hash = await hashPassword(password);
  await save();
  return true;
}

export async function renameAccount(
  email: string,
  name: string,
): Promise<boolean> {
  const account = find(email);
  if (!account) return false;
  account.name = accountName(name);
  await save();
  return true;
}

// Where and when an account was last used — the thing worth knowing after finding
// a key, or a session, you did not make.
export async function recordSignIn(email: string, from: string): Promise<void> {
  const account = find(email);
  if (!account) return;
  account.usage = { signedInAt: now(), signedInFrom: from };
  await save();
}

export type RemovalResult = { status: "removed" } | { status: "not_found" };

export async function removeAccount(email: string): Promise<RemovalResult> {
  const index = accounts.findIndex(
    (account) => account.email === normaliseEmail(email),
  );
  if (index === -1) return { status: "not_found" };
  accounts.splice(index, 1);
  await save();
  return { status: "removed" };
}
