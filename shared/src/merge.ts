// A line-based three-way merge ("diff3"), living in `shared` because the
// server runs it on every write that lost a version race, and the client's
// tests speak the same language. Given the text an edit grew out of (the
// base), the incoming edit (mine), and the newer server copy (theirs), it
// combines the two divergent edits: text only one side changed is kept from
// that side, text both sides changed identically is kept once, and only a
// region both sides changed differently is a real conflict.

export type MergeResult =
  | { status: "merged"; content: string }
  | { status: "conflict"; reason: "overlap" | "too_large" };

// A note this large is beyond collaborative editing; the write falls back to
// the plain version-conflict path instead of spending memory on the LCS.
const MAX_LCS_CELLS = 4_000_000;

function equalLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// For each line of `base`, the index of the line in `other` the longest
// common subsequence matches it to, or -1 when `other` changed it. Common
// prefixes and suffixes are matched positionally first, which keeps the LCS
// table proportional to the edited window instead of the whole note.
// Returns null when the table would exceed MAX_LCS_CELLS.
function matchMap(base: string[], other: string[]): Int32Array | null {
  const map = new Int32Array(base.length).fill(-1);
  let start = 0;
  while (
    start < base.length &&
    start < other.length &&
    base[start] === other[start]
  ) {
    start += 1;
  }
  let endBase = base.length;
  let endOther = other.length;
  while (
    endBase > start &&
    endOther > start &&
    base[endBase - 1] === other[endOther - 1]
  ) {
    endBase -= 1;
    endOther -= 1;
  }
  for (let i = 0; i < start; i += 1) map[i] = i;
  for (let i = endBase, j = endOther; i < base.length; i += 1, j += 1) {
    map[i] = j;
  }

  const n = endBase - start;
  const m = endOther - start;
  if (n === 0 || m === 0) return map;
  if (n * m > MAX_LCS_CELLS) return null;

  const width = m + 1;
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      dp[i * width + j] =
        base[start + i - 1] === other[start + j - 1]
          ? dp[(i - 1) * width + (j - 1)] + 1
          : Math.max(dp[(i - 1) * width + j], dp[i * width + (j - 1)]);
    }
  }
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (base[start + i - 1] === other[start + j - 1]) {
      map[start + i - 1] = start + j - 1;
      i -= 1;
      j -= 1;
    } else if (dp[(i - 1) * width + j] >= dp[i * width + (j - 1)]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return map;
}

// Combine mine and theirs against the base they both descende from. The base
// lines that survived unchanged in *both* texts are anchors; between any two
// anchors the two sides each offer a region. A region that only one side
// actually changed is taken from that side; a region both changed the same
// way is taken once; a region both changed differently cannot be reconciled.
export function merge3(
  base: string,
  mine: string,
  theirs: string,
): MergeResult {
  if (base === theirs) return { status: "merged", content: mine };
  if (base === mine) return { status: "merged", content: theirs };
  if (mine === theirs) return { status: "merged", content: mine };

  const b = base.split("\n");
  const m = mine.split("\n");
  const t = theirs.split("\n");
  const mm = matchMap(b, m);
  const mt = matchMap(b, t);
  if (!mm || !mt) return { status: "conflict", reason: "too_large" };

  const out: string[] = [];
  let prevB = -1;
  let prevM = -1;
  let prevT = -1;
  for (let i = 0; i <= b.length; i += 1) {
    const anchored = i < b.length && mm[i] >= 0 && mt[i] >= 0;
    if (!anchored && i < b.length) continue;
    const curM = i === b.length ? m.length : mm[i];
    const curT = i === b.length ? t.length : mt[i];

    const bRegion = b.slice(prevB + 1, i);
    const mRegion = m.slice(prevM + 1, curM);
    const tRegion = t.slice(prevT + 1, curT);
    if (equalLines(mRegion, bRegion)) {
      out.push(...tRegion);
    } else if (equalLines(tRegion, bRegion)) {
      out.push(...mRegion);
    } else if (equalLines(mRegion, tRegion)) {
      out.push(...mRegion);
    } else {
      return { status: "conflict", reason: "overlap" };
    }

    if (i === b.length) break;
    out.push(b[i]);
    prevB = i;
    prevM = curM;
    prevT = curT;
  }
  return { status: "merged", content: out.join("\n") };
}
