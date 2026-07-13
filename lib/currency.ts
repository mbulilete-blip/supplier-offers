// Grey-market offers get quoted in whatever currency a supplier invoices in
// (EUR, USD, GBP, CHF, AED - see the currency-symbol detection in
// lib/smartImport.ts). Ranking suppliers cheapest-to-priciest, coloring the
// Price Matrix, and computing "% vs RRP" only make sense once every price is
// compared in the same currency - comparing raw numbers across currencies
// (e.g. "13.89 EUR" vs "14.43 USD") silently mixes units and produces a
// misleading ranking/discount.
//
// This converts everything to EUR for comparison purposes, using rates
// refreshed periodically from a free, no-API-key exchange rate service
// (frankfurter.app, sourced from the European Central Bank's daily
// reference rates), with a static fallback table if that fetch is
// unavailable (offline, service down, etc). The original quoted amount and
// currency are always what's actually displayed - EUR conversion is only
// used behind the scenes for sorting/coloring/percentages, plus an
// "≈ X EUR" hint next to non-EUR prices so the conversion itself is visible.

export const SUPPORTED_CURRENCIES = ["EUR", "USD", "GBP", "CHF", "AED"] as const;

// Fallback rates (1 unit of currency -> EUR) - only used if the live fetch
// below fails. These don't need to be exact to the day; they only need to be
// close enough that ranking/coloring isn't badly wrong while offline.
// Approximate as of mid-2026 - update occasionally if they drift noticeably.
const FALLBACK_RATES: Record<string, number> = {
  EUR: 1,
  USD: 0.88,
  GBP: 1.15,
  CHF: 1.07,
  AED: 0.24,
};

export type EurRates = Record<string, number>;

let cachedRates: EurRates | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

async function fetchLiveRates(): Promise<EurRates | null> {
  try {
    const symbols = SUPPORTED_CURRENCIES.filter((c) => c !== "EUR").join(",");
    const res = await fetch(`https://api.frankfurter.app/latest?from=EUR&to=${symbols}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { rates?: Record<string, number> };
    if (!data.rates) return null;
    // frankfurter reports EUR -> X; invert to get the X -> EUR rate this
    // module works in everywhere else.
    const rates: EurRates = { EUR: 1 };
    for (const [code, rate] of Object.entries(data.rates)) {
      if (rate > 0) rates[code] = 1 / rate;
    }
    return rates;
  } catch {
    return null;
  }
}

// Server-side lookup - fetches live EUR conversion rates (cached in-process
// for CACHE_TTL_MS), falling back to the last good cache or the static table
// if the live fetch fails. Used by /api/fx-rates.
export async function getEurRates(): Promise<EurRates> {
  const now = Date.now();
  if (cachedRates && now - cachedAt < CACHE_TTL_MS) return cachedRates;

  const live = await fetchLiveRates();
  if (live) {
    cachedRates = { ...FALLBACK_RATES, ...live };
    cachedAt = now;
    return cachedRates;
  }
  // Live fetch failed - prefer a stale cache over the static table, since a
  // few-hour-old real rate beats a fixed approximation.
  return cachedRates ?? FALLBACK_RATES;
}

// Converts an amount in `currency` to its EUR equivalent using the given
// rates table. Unknown currencies fall back to a 1:1 rate rather than
// throwing, so an unexpected free-text currency value never breaks the page
// - it just won't be perfectly ranked against the others.
export function toEur(amount: number, currency: string | null | undefined, rates: EurRates): number {
  const key = (currency ?? "EUR").trim().toUpperCase();
  const rate = rates[key] ?? 1;
  return amount * rate;
}
