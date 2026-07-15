import { NextRequest, NextResponse } from "next/server";
import { getQuote, updateQuote, deleteQuote, QuoteInput, QUOTE_STATUSES } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }
  const quote = await getQuote(id);
  if (!quote) {
    return NextResponse.json({ error: "Quote not found." }, { status: 404 });
  }
  return NextResponse.json(quote);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  const body = (await req.json()) as Partial<QuoteInput>;
  if (body.status && !QUOTE_STATUSES.includes(body.status)) {
    return NextResponse.json(
      { error: `status must be one of: ${QUOTE_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  const quote = await updateQuote(id, body);
  if (!quote) {
    return NextResponse.json({ error: "Quote not found." }, { status: 404 });
  }
  return NextResponse.json(quote);
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }
  const ok = await deleteQuote(id);
  if (!ok) {
    return NextResponse.json({ error: "Quote not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
