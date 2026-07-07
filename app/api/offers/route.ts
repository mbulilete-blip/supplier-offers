import { NextRequest, NextResponse } from "next/server";
import { listOffers, createOffer } from "@/lib/db";
import { OfferInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const offers = await listOffers();
  return NextResponse.json(offers);
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as OfferInput;

  if (!body.supplier || !body.brand || !body.product || body.price === undefined) {
    return NextResponse.json(
      { error: "supplier, brand, product, and price are required." },
      { status: 400 }
    );
  }

  const offer = await createOffer({
    ...body,
    price: Number(body.price),
    rrp: body.rrp !== undefined && body.rrp !== null ? Number(body.rrp) : null,
    moq: body.moq !== undefined && body.moq !== null ? Number(body.moq) : null,
    leadTimeDays:
      body.leadTimeDays !== undefined && body.leadTimeDays !== null
        ? Number(body.leadTimeDays)
        : null,
  });

  return NextResponse.json(offer, { status: 201 });
}
