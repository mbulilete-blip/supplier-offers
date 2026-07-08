// Fuzzy-groups raw supplier strings that are really the same supplier, just
// with a price-list batch label tacked on - e.g. "AVOLTA 30.04.26", "AVOLTA
// PROMO 2506", "AVOLTA SPECIAL 250526" are all the same supplier (AVOLTA),
// but each price-list upload used the sheet/tab name (supplier + batch date
// or promo tag) as the literal supplier value, the same class of bug we
// found earlier with brand names getting polluted by sheet-tab naming.
//
// This is a heuristic, not a guaranteed-correct parse: it keeps leading
// tokens as the "real" supplier name and stops at the first token that looks
// like a date/numeric batch code or a known non-supplier keyword (PROMO,
// SPECIAL, STOCK, month names, etc). Shared between client (History page
// dropdown) and server (grouped supplier listing) so both agree on the same
// grouping.

const NOISE_WORDS = new Set([
  "promo",
  "special",
  "stock",
  "available",
  "incoming",
  "pcs",
  "plus",
  "value",
  "week",
  "batch",
  "list",
  "new",
  "old",
  "sale",
  "discount",
  "offer",
  "clearance",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]);

const containsDigit = (token: string): boolean => /\d/.test(token);

export function canonicalSupplier(raw: string): string {
  const withoutParens = raw.replace(/\(.*?\)/g, " ").trim();
  const tokens = withoutParens.split(/\s+/).filter(Boolean);

  const kept: string[] = [];
  for (const token of tokens) {
    const bare = token.replace(/[^\p{L}\p{N}]/gu, "");
    if (containsDigit(token) || NOISE_WORDS.has(bare.toLowerCase())) break;
    kept.push(token);
  }

  const canonical = kept.join(" ").trim();
  // If everything got stripped (e.g. the raw value was entirely noise, like
  // a leftover spreadsheet header), fall back to the original rather than
  // inventing an empty group.
  return canonical || raw.trim();
}

export type SupplierGroup = {
  canonical: string;
  count: number;
  variants: { supplier: string; count: number }[];
};

export function groupSuppliers(
  suppliers: { supplier: string; count: number }[]
): SupplierGroup[] {
  const map = new Map<string, SupplierGroup>();
  for (const s of suppliers) {
    const canonical = canonicalSupplier(s.supplier);
    if (!map.has(canonical)) map.set(canonical, { canonical, count: 0, variants: [] });
    const g = map.get(canonical)!;
    g.count += s.count;
    g.variants.push(s);
  }
  return Array.from(map.values()).sort((a, b) => a.canonical.localeCompare(b.canonical));
}
