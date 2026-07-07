import { NextRequest, NextResponse } from "next/server";
import { updateOffer, deleteOffer } from "@/lib/db";
import { OfferInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  const body = (await req.json()) as Partial<OfferInput>;
  const offer = await updateOffer(id, body);

  if (!offer) {
    return NextResponse.json({ error: "Offer not found." }, { status: 404 });
  }
  return NextResponse.json(offer);
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  const ok = await deleteOffer(id);
  if (!ok) {
    return NextResponse.json({ error: "Offer not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
