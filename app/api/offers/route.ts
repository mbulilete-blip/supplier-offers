import { NextRequest, NextResponse } from "next/server";
import { listOffers, createOffer } from "@/lib/db";
import { OfferInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search") ?? undefined;
  const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined;
  const page = searchParams.get("page") ? Number(searchParams.get("page")) : 1;
  const effectiveLimit = limit && !Number.isNaN(limit) ? limit : 100;
  const offset = (Math.max(page, 1) - 1) * effectiveLimit;

  const { offers, total } = await listOffers({ search, limit: effectiveLimit, offset });
  return NextResponse.json({ offers, total, page: Math.max(page, 1), pageSize: effectiveLimit });
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
