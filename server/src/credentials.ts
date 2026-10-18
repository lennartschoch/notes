import type { Response } from "express";
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
export type CredentialKind = "access" | "apikey" | "session" | "dev";

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
  // Which of the account's own sign-ins this request came from, when it came from
  // one: it is what signing out, or changing a password, takes aim at.
  sessionId?: string;
}

// Why a request was turned away. The difference matters to the caller: a token
// that did not verify is Cloudflare's problem, a token that grants no account is
// a setting this app's operator has not made.
export type AuthFailure =
  | "no_credential"
  | "invalid_token"
  | "invalid_key"
  | "invalid_session"
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

// ------------------------------------------------------------------ cookie

// The two spellings of the session cookie. `__Host-` is the strong one: the
// browser will only send it back to this exact host, set by a page on it, with no
// `Domain` and no path games — which is worth having, but requires `Secure`, and a
// LAN deployment on plain http has no `Secure` to give it. So the app uses the
// strong name when the connection is HTTPS and the plain one otherwise, and reads
// either.
export const HOST_COOKIE = "__Host-notes_session";
export const PLAIN_COOKIE = "notes_session";

function cookieNames(secure: boolean): string[] {
  return secure ? [HOST_COOKIE, PLAIN_COOKIE] : [PLAIN_COOKIE, HOST_COOKIE];
}

// The value of the first of `names` the request's Cookie header carries.
export function cookieValue(
  header: string | undefined,
  names: string[],
): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (names.includes(name)) return part.slice(separator + 1).trim();
  }
  return "";
}

export function sessionCookieValue(headers: Credentials["headers"]): string {
  const raw = headers.cookie;
  const header = Array.isArray(raw) ? raw[0] : raw;
  return cookieValue(
    typeof header === "string" ? header : "",
    cookieNames(false),
  );
}

// `Max-Age` is spelled out as well as `Expires`: an old browser is rare, but a
// cookie that outlives its session because a header was missed is not.
function setCookie(
  res: Response,
  name: string,
  value: string,
  options: { secure: boolean; maxAgeSeconds: number },
): void {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(options.maxAgeSeconds)}`,
    `Expires=${new Date(Date.now() + options.maxAgeSeconds * 1000).toUTCString()}`,
  ];
  if (options.secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

// Setting a session cookie. `secure` is the caller's answer to "did this request
// arrive over HTTPS", which — over a proxy — is only knowable if the operator said
// the proxy may be believed (see network.ts).
export function setSessionCookie(
  res: Response,
  token: string,
  secure: boolean,
  maxAgeSeconds: number,
): void {
  setCookie(res, secure ? HOST_COOKIE : PLAIN_COOKIE, token, {
    secure,
    maxAgeSeconds,
  });
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  for (const name of cookieNames(secure))
    setCookie(res, name, "", { secure, maxAgeSeconds: 0 });
}

// -------------------------------------------------------- session credentials

export interface SessionGrant {
  id: string;
  email: string;
}

export interface SessionStore {
  lookup: (token: string) => Promise<SessionGrant | undefined>;
}

let sessionStore: SessionStore | undefined;

// Given its store by the app's entrance, exactly like the key provider: the chain
// decides who a caller is and never touches a file. `undefined` means a deployment
// with no local sign-ins at all.
export function configureSessionStore(store: SessionStore | undefined): void {
  sessionStore = store;
}

// A signed-in browser. It is a person's own credential, so it never arrives as an
// agent — and unlike an Access token, it is one the app can take back.
export function sessionProvider(): Provider {
  return {
    kind: "session",
    async match({ headers }) {
      const token = sessionCookieValue(headers);
      if (token.length === 0) return PASS;
      if (!sessionStore) return { kind: "deny", reason: "invalid_session" };
      const session = await sessionStore.lookup(token);
      if (!session) return { kind: "deny", reason: "invalid_session" };
      return {
        kind: "identity",
        identity: {
          email: session.email,
          via: "session",
          sessionId: session.id,
        },
      };
    },
  };
}

// Whether an Access assertion is checked at all. A development switch only, and an
// alarming one to leave set: skipping verification is a claim that whatever sent
// the header *is* Cloudflare, which nothing but the network can support. It is read
// per request so a mistake cannot be made once at boot and inherited forever.
export function accessAssertionsVerified(): boolean {
  return process.env.ACCESS_NOT_VERIFIED !== "1";
}
