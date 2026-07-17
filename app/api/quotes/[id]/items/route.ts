import { NextRequest, NextResponse } from "next/server";
import { addQuoteItem, QuoteItemInput } from "@/lib/db";

export const dynamic = "force-dynamic";

// Adds a new line item to an already-saved quote - e.g. the customer asks to
// add another product after the quote was first sent.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const quoteId = Number(params.id);
  if (!Number.isFinite(quoteId)) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  const body = (await req.json()) as QuoteItemInput;
  if (!body.product || !body.product.trim()) {
    return NextResponse.json({ error: "product is required." }, { status: 400 });
  }

  const item = await addQuoteItem(quoteId, body);
  if (!item) {
    return NextResponse.json({ error: "Quote not found." }, { status: 404 });
  }
  return NextResponse.json(item, { status: 201 });
}
