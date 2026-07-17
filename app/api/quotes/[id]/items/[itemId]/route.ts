import { NextRequest, NextResponse } from "next/server";
import { updateQuoteItem, deleteQuoteItem, QuoteItemInput } from "@/lib/db";

export const dynamic = "force-dynamic";

// Edits one line item on a saved quote - e.g. correcting a qty typo, moving to
// a cheaper supplier, or adjusting the sell price mid-negotiation.
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string; itemId: string } }
) {
  const quoteId = Number(params.id);
  const itemId = Number(params.itemId);
  if (!Number.isFinite(quoteId) || !Number.isFinite(itemId)) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  const body = (await req.json()) as Partial<QuoteItemInput>;
  if (body.product !== undefined && !body.product.trim()) {
    return NextResponse.json({ error: "product cannot be empty." }, { status: 400 });
  }

  const item = await updateQuoteItem(quoteId, itemId, body);
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  return NextResponse.json(item);
}

// Removes one line item from a saved quote - e.g. the customer dropped a
// product from the order.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; itemId: string } }
) {
  const quoteId = Number(params.id);
  const itemId = Number(params.itemId);
  if (!Number.isFinite(quoteId) || !Number.isFinite(itemId)) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  const ok = await deleteQuoteItem(quoteId, itemId);
  if (!ok) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
