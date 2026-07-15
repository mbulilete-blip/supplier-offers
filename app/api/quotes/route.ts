import { NextRequest, NextResponse } from "next/server";
import { createQuote, listQuotes, QuoteInput } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const quotes = await listQuotes();
  return NextResponse.json(quotes);
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as QuoteInput;

  if (!body.customerName || !body.customerName.trim()) {
    return NextResponse.json({ error: "customerName is required." }, { status: 400 });
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: "At least one item is required." }, { status: 400 });
  }
  for (const item of body.items) {
    if (!item.product || !item.product.trim()) {
      return NextResponse.json({ error: "Every item needs a product name." }, { status: 400 });
    }
  }

  const quote = await createQuote(body);
  return NextResponse.json(quote, { status: 201 });
}
