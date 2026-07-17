import { NextRequest, NextResponse } from "next/server";
import { getOfferPriceHistory } from "@/lib/db";

export const dynamic = "force-dynamic";

// Chronological price/RRP trail for a single offer - see offer_price_history
// in lib/db.ts. Powers the "Price history" section in EditOfferModal.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  const history = await getOfferPriceHistory(id);
  return NextResponse.json(history);
}
