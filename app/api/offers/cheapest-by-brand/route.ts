import { NextRequest, NextResponse } from "next/server";
import { listBrandGroups, listOffers } from "@/lib/db";
import { normalizeBrandKey } from "@/lib/brandNormalize";
import { getEurRates, toEur } from "@/lib/currency";

export const dynamic = "force-dynamic";

type CheapestResult = {
  supplier: string;
  brand: string;
  product: string;
  sku: string | null;
  price: number;
  currency: string;
  priceEur: number;
  createdAt: string;
} | null;

// Beauty Hub's sent_offers only records a brand name (no SKU), so this
// answers "what's the cheapest live price on file for this brand, right
// now" - used to sanity-check a historical sent-offer's cost against
// current supply (see /app/sent-offers and /app/brand/[name] there).
// Batched by design: one request per page load, not one per row.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const brandsParam = searchParams.get("brands") ?? "";
  const requested = brandsParam
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);

  if (requested.length === 0) {
    return NextResponse.json({ error: "brands param is required (comma-separated)." }, { status: 400 });
  }

  const [groups, rates] = await Promise.all([listBrandGroups(), getEurRates()]);

  const results: Record<string, CheapestResult> = {};

  await Promise.all(
    requested.map(async (rawBrand) => {
      const needle = normalizeBrandKey(rawBrand);
      const group = groups.find(
        (g) =>
          normalizeBrandKey(g.canonical) === needle ||
          g.variants.some((v) => normalizeBrandKey(v.brand) === needle)
      );
      // Fall back to the raw string itself if it's not a brand we've grouped
      // (e.g. a brand that only exists in Beauty Hub, never quoted here).
      const brandIn = group ? group.variants.map((v) => v.brand) : [rawBrand];

      const { offers } = await listOffers({ brandIn, limit: 5000 });
      if (offers.length === 0) {
        results[rawBrand] = null;
        return;
      }

      let cheapest = offers[0];
      let cheapestEur = toEur(cheapest.price, cheapest.currency, rates);
      for (const o of offers) {
        const eur = toEur(o.price, o.currency, rates);
        if (eur < cheapestEur) {
          cheapest = o;
          cheapestEur = eur;
        }
      }

      results[rawBrand] = {
        supplier: cheapest.supplier,
        brand: cheapest.brand,
        product: cheapest.product,
        sku: cheapest.sku ?? null,
        price: cheapest.price,
        currency: cheapest.currency,
        priceEur: Math.round(cheapestEur * 100) / 100,
        createdAt: cheapest.createdAt,
      };
    })
  );

  return NextResponse.json({ results });
}
