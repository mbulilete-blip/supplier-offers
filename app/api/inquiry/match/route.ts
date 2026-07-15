import { NextRequest, NextResponse } from "next/server";
import { matchInquiryItem } from "@/lib/db";
import { Offer } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Each item runs its own query (SKU-exact or fuzzy AND-of-words), so this
// caps total work per request to keep it inside the function time limit —
// a client inquiry is realistically tens of lines, not thousands.
const MAX_INQUIRY_ITEMS = 300;
// How many queries run at once. The pg pool is capped at 5 connections (see
// lib/db.ts), so this matches that ceiling instead of overwhelming it.
const CONCURRENCY = 5;

export type InquiryRequestItem = {
  raw: string;
  brand: string | null;
  product: string;
  sku: string | null;
  qty: number | null;
  targetPrice: number | null;
  targetCurrency: string | null;
};

export type InquiryResultRow = {
  item: InquiryRequestItem;
  offers: Offer[];
};

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { items?: InquiryRequestItem[] };
  const items = Array.isArray(body.items) ? body.items : [];

  if (items.length === 0) {
    return NextResponse.json({ error: "No inquiry items provided." }, { status: 400 });
  }

  const truncated = items.length > MAX_INQUIRY_ITEMS;
  const itemsToMatch = items.slice(0, MAX_INQUIRY_ITEMS);

  const offersPerItem = await mapWithConcurrency(itemsToMatch, CONCURRENCY, (item) =>
    matchInquiryItem({ brand: item.brand, product: item.product, sku: item.sku })
  );

  const results: InquiryResultRow[] = itemsToMatch.map((item, i) => ({
    item,
    offers: offersPerItem[i],
  }));

  const summary = {
    total: results.length,
    matched: results.filter((r) => r.offers.length > 0).length,
    unmatched: results.filter((r) => r.offers.length === 0).length,
  };

  return NextResponse.json({ results, summary, truncated });
}
