// Slowing down somebody who is guessing.
//
// The expensive hash is most of the defence — 100 ms a try is 864 000 tries a day
// per core, and a good password outlasts that — but it costs the same whether the
// guesser is one person who mistyped or a bot working through a list. This counts
// the second kind and stops answering it, per account *and* per address, so a
// person who mistypes four times is not locked out of their own notes by a
// stranger doing the same.
//
// Deliberately in memory: the point is to make a running attack slow, not to hold
// a grudge across a restart, and a persistent lockout is a way for an attacker to
// lock a real person out of their own account by guessing badly on purpose.

export const MAX_ATTEMPTS = 5;
export const WINDOW_MS = 15 * 60 * 1000;
export const BASE_BLOCK_MS = 30_000;

interface Trail {
  failures: number;
  firstAt: number;
  blockedUntil: number;
}

const trails = new Map<string, Trail>();

export type Decision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export function attempt(key: string): Decision {
  const trail = trails.get(key);
  if (!trail) return { allowed: true };
  const instant = Date.now();
  if (instant - trail.firstAt > WINDOW_MS) {
    trails.delete(key);
    return { allowed: true };
  }
  if (trail.blockedUntil > instant) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((trail.blockedUntil - instant) / 1000),
    };
  }
  return { allowed: true };
}

// A wrong password. The wait doubles with each further failure, to a quarter of an
// hour, which is enough to make a wordlist absurd without punishing the person who
// owns the account.
export function failed(key: string): Decision {
  const instant = Date.now();
  const trail = trails.get(key);
  const fresh =
    !trail || instant - trail.firstAt > WINDOW_MS
      ? { failures: 0, firstAt: instant, blockedUntil: 0 }
      : trail;
  fresh.failures += 1;
  const blocked =
    fresh.failures >= MAX_ATTEMPTS
      ? Math.min(
          BASE_BLOCK_MS * 2 ** (fresh.failures - MAX_ATTEMPTS),
          15 * 60_000,
        )
      : 0;
  fresh.blockedUntil = blocked > 0 ? instant + blocked : 0;
  trails.set(key, fresh);
  return blocked > 0
    ? { allowed: false, retryAfterSeconds: Math.ceil(blocked / 1000) }
    : { allowed: true };
}

export function succeeded(key: string): void {
  trails.delete(key);
}

// How many trails are being remembered: a number worth watching on a running
// process, and the only way a test can tell "answered" from "never asked".
export function watchedCount(): number {
  return trails.size;
}

export function forgetEverything(): void {
  trails.clear();
}

// A trail is worth less memory than a person is worth waiting for.
export function sweep(): number {
  const instant = Date.now();
  let gone = 0;
  for (const [key, trail] of trails) {
    if (instant - trail.firstAt > WINDOW_MS * 2) {
      trails.delete(key);
      gone += 1;
    }
  }
  return gone;
}
