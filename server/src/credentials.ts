import type { Actor } from "./types.js";

// Reading credentials off a request.
//
// This module knows what each credential *looks like* and how to ask its owner
// whether it means anything; it decides nothing about who a caller is, and knows
// no filenames. That separation is not tidiness: an identity module that read the
// key file directly would drag a whole store into any test that imports the chain.

// Which kind of credential granted an identity. Named after the credential,
// never after anything the caller says about itself, so a machine cannot
// describe its way into appearing to be a person.
export type CredentialKind = "access" | "apikey" | "dev";

// An identity, ready to be used as an Actor. `via` records where the grant came
// from, for this app's own bookkeeping; whether an agent was driving the account
// is part of every actor, and is derived from the credential, never claimed.
export interface Identity extends Actor {
  via: CredentialKind;
  // Which of the account's API keys opened this request, when it was a key. Two
  // things need that precision: revoking a key takes its live sessions down with
  // it, and a key may not mint, list or name the others — a credential that could
  // hand out credentials would outlive its own revocation.
  keyId?: string;
}

// Why a request was turned away. The difference matters to the caller: a token
// that did not verify is Cloudflare's problem, a token that grants no account is
// a setting this app's operator has not made.
export type AuthFailure =
  | "no_credential"
  | "invalid_token"
  | "invalid_key"
  | "no_account";

// Everything a provider may read a credential off: the headers of an HTTP
// request or of a WebSocket upgrade — both are the same bag — plus the one thing
// a browser socket cannot carry, described at `devProvider`.
export interface Credentials {
  headers: Record<string, string | undefined | string[]>;
  queryEmail?: string | null;
}

export type Match =
  // Presents none of this provider's credentials: ask the next one.
  | { kind: "pass" }
  | { kind: "identity"; identity: Identity }
  // A credential of ours that grants nobody: the request is refused, and nothing
  // further is asked.
  | { kind: "deny"; reason: AuthFailure };

// What every entrance gets back: an identity, or the one reason there is none.
export type Outcome =
  | { ok: true; identity: Identity }
  | { ok: false; reason: AuthFailure };

export const PASS: Match = { kind: "pass" };

export interface Provider {
  kind: CredentialKind;
  match(credentials: Credentials): Promise<Match>;
}

export function headerValue(
  headers: Credentials["headers"],
  name: string,
): string {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value.trim() : "";
}

// The bearer token a request carries, if it carries one.
export function bearerToken(headers: Credentials["headers"]): string {
  const authorization = headerValue(headers, "authorization");
  if (!/^bearer\s+/i.test(authorization)) return "";
  const separator = authorization.indexOf(" ");
  return authorization.slice(separator + 1).trim();
}

// ---------------------------------------------------------------- API keys

// What a key looks like on the wire. The prefix is what tells the app which
// credential a bearer token is, so the two kinds of bearer token are both
// accepted without either of them guessing at the other.
export const API_KEY_PREFIX = "notes_";

export function looksLikeApiKey(secret: string): boolean {
  return secret.startsWith(API_KEY_PREFIX);
}

export interface ApiKeyGrant {
  id: string;
  account: string;
}

export interface ApiKeyStore {
  // The key a presented secret is, or undefined when it is not one of ours.
  lookup: (secret: string) => Promise<ApiKeyGrant | undefined>;
  // That a key was just used, for its owner's list. Fire and forget: a request
  // that has been vouched for should not wait for the disk.
  used?: (id: string) => Promise<void>;
}

// The store is given to the chain at boot, by the app's entrance (index.ts) —
// which is why this module imports no store, and a test can drive the whole
// chain with a lookup of its own.
let keyStore: ApiKeyStore | undefined;

// `undefined` is a deployment with no keys at all: the provider then refuses any
// key it is shown, which is how the chain behaves before an app has wired one up.
export function configureApiKeyStore(store: ApiKeyStore | undefined): void {
  keyStore = store;
}

// This app's own machine credential: a key a person minted and can revoke, which
// needs no Cloudflare and stores no secret of ours beyond a hash. It acts as the
// whole account — every note it can reach, exactly as the person can — because
// that is what the Access token it replaces does, and a narrower promise would be
// a second policy nobody asked for.
//
// A key is a machine even when a person is holding it: the account's own
// credential says person, this one says machine, and other people are told the
// difference.
export function apiKeyProvider(): Provider {
  return {
    kind: "apikey",
    async match({ headers }) {
      const secret = bearerToken(headers);
      if (!looksLikeApiKey(secret)) return PASS;
      // Nothing was ever configured to answer for keys, so this one cannot be
      // checked. Refused, not passed on: a credential that is presented is not an
      // invitation to try the next, weaker one.
      if (!keyStore) return { kind: "deny", reason: "invalid_key" };
      const key = await keyStore.lookup(secret);
      if (!key) return { kind: "deny", reason: "invalid_key" };
      if (keyStore.used) void keyStore.used(key.id).catch(() => {});
      return {
        kind: "identity",
        identity: {
          email: key.account,
          agent: true,
          via: "apikey",
          keyId: key.id,
        },
      };
    },
  };
}
