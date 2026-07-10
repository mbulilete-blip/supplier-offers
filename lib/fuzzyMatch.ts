// Lightweight fuzzy matching for search boxes (brand/supplier pickers etc.)
// - tolerant of case, punctuation, and minor typos so a query like "matiere
// premiere" also surfaces "MATIERE PREMIERE." or "Materia Premiere", and
// "mesoestetic" matches both "MESOESTETIC" and "MESOESTETIC.". No external
// dependency: just normalization + a capped Levenshtein distance, which is
// cheap enough to run against a full brand/supplier list on every keystroke.

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// Classic Levenshtein edit distance. Only ever called on short strings
// (search queries and similarly-sized windows of a target string), so the
// O(m*n) cost stays negligible.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// True if every character of `needle` appears in `haystack` in order (not
// necessarily contiguous) - catches abbreviation-style queries.
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

// Lower is better. Returns null when the query doesn't match at all.
export function fuzzyScore(query: string, target: string): number | null {
  const q = normalize(query);
  const t = normalize(target);
  if (!q) return 0;
  if (q === t) return 0;
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 2;

  // Typo tolerance: allow a small edit distance scaled to query length, so
  // e.g. "materia premiere" still finds "matiere premiere".
  const maxDistance = q.length <= 4 ? 1 : q.length <= 8 ? 2 : 3;

  const bestWindowDistance = (() => {
    if (t.length <= q.length) return levenshtein(q, t);
    let best = Infinity;
    for (let i = 0; i + q.length <= t.length && best > 0; i++) {
      const window = t.slice(i, i + q.length);
      const d = levenshtein(q, window);
      if (d < best) best = d;
    }
    return best;
  })();
  if (bestWindowDistance <= maxDistance) return 3;

  if (isSubsequence(q, t)) return 4;

  return null;
}

// Filters `items` to fuzzy matches of `query` and sorts best-match-first
// (falling back to alphabetical, case-insensitive, among equal scores).
// Returns `items` unchanged (in whatever order they came in) when the query
// is blank.
export function fuzzyFilterSort<T>(
  items: T[],
  query: string,
  getText: (item: T) => string
): T[] {
  const q = query.trim();
  if (!q) return items;

  const scored: { item: T; score: number; text: string }[] = [];
  for (const item of items) {
    const text = getText(item);
    const score = fuzzyScore(q, text);
    if (score !== null) scored.push({ item, score, text });
  }
  scored.sort(
    (a, b) => a.score - b.score || a.text.localeCompare(b.text, undefined, { sensitivity: "base" })
  );
  return scored.map((s) => s.item);
}
