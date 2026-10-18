import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

// Password hashing, on the theory that a notes app should not need a native
// module to keep people out.
//
// scrypt is in Node's standard library, is memory-hard, and takes the same
// parameters Node's own docs recommend. The encoded form carries them, so a hash
// written by an older build still verifies after the cost is raised — and an old,
// cheaper hash is silently rehashed the next time the person proves the password
// rather than leaving them on it forever.
//
// API keys are *not* hashed like this: a key is 192 bits of randomness, so there
// is nothing to guess, and every request would pay the cost of slowing a guesser
// down. A password is chosen, which is the whole difference.

const KEY_LENGTH = 64;
// 32 MB of memory, which is what makes a stolen hash file expensive to work on
// rather than merely inconvenient. `maxmem` is spelled out because the cost is
// exactly Node's own default ceiling, and a build that lowers it should fail here
// rather than at somebody's first sign-in.
const PARAMS: ScryptOptions = {
  N: 32_768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

interface Derived {
  (
    password: string,
    salt: Buffer,
    length: number,
    options: ScryptOptions,
  ): Promise<Buffer>;
}

const derive: Derived = (password, salt, length, options) =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, length, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });

// `options` is the cost, and the result carries it. Production passes nothing and
// gets whatever this build thinks is right; a test can ask for the cost an older
// build would have written, and check that this one notices.
export async function hashPassword(
  password: string,
  options: ScryptOptions = PARAMS,
): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derive(password, salt, KEY_LENGTH, options);
  return [
    "scrypt",
    options.N,
    options.r,
    options.p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

interface Parsed {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(encoded: string): Parsed | undefined {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;
  const [_, n, r, p, salt, hash] = parts;
  const parsed: Parsed = {
    n: Number(n),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(String(salt), "base64"),
    hash: Buffer.from(String(hash), "base64"),
  };
  if (
    !Number.isInteger(parsed.n) ||
    !Number.isInteger(parsed.r) ||
    !Number.isInteger(parsed.p) ||
    parsed.n < 2 ||
    parsed.r < 1 ||
    parsed.p < 1 ||
    parsed.salt.length === 0 ||
    parsed.hash.length !== KEY_LENGTH
  ) {
    return undefined;
  }
  return parsed;
}

// Whether `password` is the one this hash was made from. Anything shaped
// otherwise — a plaintext value that leaked into the file, a hash from another
// tool, a truncated record — fails rather than being trusted or crashing.
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parsed = parse(encoded);
  if (!parsed) return false;
  const derived = await derive(password, parsed.salt, parsed.hash.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: PARAMS.maxmem,
  });
  return timingSafeEqual(derived, parsed.hash);
}

// Whether this hash was made with weaker parameters than this build would choose.
export function passwordNeedsRehash(encoded: string): boolean {
  const parsed = parse(encoded);
  if (!parsed) return true;
  return (
    parsed.n !== PARAMS.N || parsed.r !== PARAMS.r || parsed.p !== PARAMS.p
  );
}
