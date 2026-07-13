import { NextRequest, NextResponse } from "next/server";
import { listOffers, createOffer } from "@/lib/db";
import { OfferInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search") ?? undefined;
  const brand = searchParams.get("brand") ?? undefined;
  const supplier = searchParams.get("supplier") ?? undefined;
  // Comma-separated list of exact raw supplier values - used by the History
  // page to fetch every offer belonging to a fuzzy-matched group of supplier
  // name variants (e.g. "AVOLTA 30.04.26", "AVOLTA PROMO 2506", ...) in one
  // request. Takes precedence over `supplier` when present.
  const suppliersParam = searchParams.get("suppliers") ?? undefined;
  const supplierIn = suppliersParam
    ? suppliersParam.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined;
  const page = searchParams.get("page") ? Number(searchParams.get("page")) : 1;
  const effectiveLimit = limit && !Number.isNaN(limit) ? limit : 100;
  const offset = (Math.max(page, 1) - 1) * effectiveLimit;

  const { offers, total } = await listOffers({
    search,
    brand,
    supplier,
    supplierIn,
    limit: effectiveLimit,
    offset,
  });
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
    moq: body.moq !== undefined && body.moq !== null ? String(body.moq).trim() || null : null,
    leadTimeDays:
      body.leadTimeDays !== undefined && body.leadTimeDays !== null
        ? String(body.leadTimeDays).trim() || null
        : null,
  });

  return NextResponse.json(offer, { status: 201 });
}
