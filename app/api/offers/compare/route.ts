import { NextRequest, NextResponse } from "next/server";
import { getMarketMatches, getMarketMatchesBySku } from "@/lib/db";
import { offersFromCsv } from "@/lib/csv";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Cap how many distinct rows we'll run a market-comparison lookup for in one
// request, to keep this fast and inside the function time limit.
const MAX_COMPARE_ROWS = 5000;

export type CompareRow = {
  supplier: string;
  brand: string;
  product: string;
  sku: string | null;
  price: number;
  currency: string;
  marketBestPrice: number | null;
  marketBestSupplier: string | null;
  marketBestCurrency: string | null;
  verdict: "cheaper" | "matches" | "higher" | "new";
};

export async function POST(req: NextRequest) {
  const { csv } = (await req.json()) as { csv: string };

  if (!csv || typeof csv !== "string") {
    return NextResponse.json({ error: "No CSV content provided." }, { status: 400 });
  }

  const { offers, errors } = offersFromCsv(csv);
  const truncated = offers.length > MAX_COMPARE_ROWS;
  const rowsToCompare = offers.slice(0, MAX_COMPARE_ROWS);

  // Prefer matching on SKU/EAN/barcode when the uploaded row has one — it's
  // the one identifier that stays consistent even when a supplier's own
  // brand/product text doesn't match what's already on file (e.g. "HUDA"
  // vs. "Huda Beauty", or slightly different product wording). Fall back to
  // brand+product text matching only for rows with no SKU.
  const skus = rowsToCompare.map((o) => o.sku).filter((s): s is string => !!s && s.trim() !== "");
  const pairs = rowsToCompare.map((o) => ({ brand: o.brand, product: o.product }));
  const [skuMatches, bpMatches] = await Promise.all([getMarketMatchesBySku(skus), getMarketMatches(pairs)]);

  const rows: CompareRow[] = rowsToCompare.map((o) => {
    const skuKey = o.sku?.trim().toLowerCase();
    const bpKey = `${o.brand.trim().toLowerCase()}|${o.product.trim().toLowerCase()}`;
    const existing = (skuKey ? skuMatches.get(skuKey) : undefined) ?? bpMatches.get(bpKey) ?? [];

    const best = existing.reduce<{ supplier: string; price: number; currency: string } | null>(
      (acc, m) => (acc === null || m.price < acc.price ? { supplier: m.supplier, price: m.price, currency: m.currency } : acc),
      null
    );

    const marketBestPrice: number | null = best === null ? null : best.price;
    const marketBestSupplier: string | null = best === null ? null : best.supplier;
    const marketBestCurrency: string | null = best === null ? null : best.currency;

    let verdict: CompareRow["verdict"];
    if (marketBestPrice === null) verdict = "new";
    else if (o.price < marketBestPrice) verdict = "cheaper";
    else if (o.price === marketBestPrice) verdict = "matches";
    else verdict = "higher";

    return {
      supplier: o.supplier,
      brand: o.brand,
      product: o.product,
      sku: o.sku ?? null,
      price: o.price,
      currency: o.currency ?? "EUR",
      marketBestPrice,
      marketBestSupplier,
      marketBestCurrency,
      verdict,
    };
  });

  const summary = {
    total: rows.length,
    cheaper: rows.filter((r) => r.verdict === "cheaper").length,
    matches: rows.filter((r) => r.verdict === "matches").length,
    higher: rows.filter((r) => r.verdict === "higher").length,
    new: rows.filter((r) => r.verdict === "new").length,
  };

  return NextResponse.json({ rows, summary, errors, truncated });
}
