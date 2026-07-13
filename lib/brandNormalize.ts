// Fuzzy-groups raw brand strings that are really the same brand, just
// spelled with different capitalization or diacritics - e.g. "ANNEMARIE
// BORLIND", "Annemarie Börlind", and "annemarie borlind" should all show up
// as one brand in pickers instead of as separate near-duplicate entries.
//
// Unlike lib/supplierNormalize.ts (which strips trailing batch/date/promo
// tokens off supplier names), the brand duplication problem is purely case
// and accent variation, so the normalization here is simpler: decompose
// accented characters, drop the combining marks, lowercase, and collapse
// non-alphanumeric runs to a single space. Shared between server (grouped
// brand listing) and any client code that needs to agree on the same
// grouping key.

// Matches Unicode "Mark, nonspacing" characters - after NFD decomposition,
// this is exactly the set of combining accent marks (e.g. the separate
// combining grave/acute/umlaut characters produced when "ö" is decomposed
// into "o" + a combining diaeresis), so stripping them collapses accented
// letters down to their plain-letter equivalents.
const COMBINING_DIACRITICS = /\p{Mn}/gu;

export function normalizeBrandKey(raw: string): string {
  const key = raw
    .trim()
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  // If everything got stripped (e.g. punctuation-only value), fall back to
  // the lowercased raw string rather than collapsing distinct-looking values
  // into one empty-key group.
  return key || raw.trim().toLowerCase();
}

export type BrandGroup = {
  canonical: string;
  count: number;
  variants: { brand: string; count: number }[];
};

export function groupBrands(brands: { brand: string; count: number }[]): BrandGroup[] {
  const map = new Map<string, { count: number; variants: { brand: string; count: number }[] }>();
  for (const b of brands) {
    const key = normalizeBrandKey(b.brand);
    if (!map.has(key)) map.set(key, { count: 0, variants: [] });
    const g = map.get(key)!;
    g.count += b.count;
    g.variants.push(b);
  }

  const groups: BrandGroup[] = Array.from(map.values()).map((g) => {
    // Display the most common spelling as the canonical label (ties broken
    // alphabetically) - a better default than always preferring e.g.
    // ALL-CAPS or Title Case, since either convention could be the majority
    // in a given dataset.
    const sortedVariants = [...g.variants].sort(
      (a, b) => b.count - a.count || a.brand.localeCompare(b.brand)
    );
    return {
      canonical: sortedVariants[0].brand,
      count: g.count,
      variants: sortedVariants,
    };
  });

  return groups.sort((a, b) => a.canonical.localeCompare(b.canonical));
}
