import { NextResponse } from "next/server";
import { getEurRates } from "@/lib/currency";

export const dynamic = "force-dynamic";

// Powers cross-currency ranking/coloring on the Price Matrix - see
// lib/currency.ts for the source and caching behavior.
export async function GET() {
  const rates = await getEurRates();
  return NextResponse.json(rates);
}
