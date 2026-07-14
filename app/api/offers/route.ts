import { NextRequest, NextResponse } from "next/server";
import { listOffers, createOffer } from "@/lib/db";
import { OfferInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search") ?? undefined;
  const brand = searchParams.get("brand") ?? undefined;
  // Comma-separated list of exact raw brand values - used by the Matrix page
  // to fetch every offer belonging to a fuzzy-matched group of brand name
  // variants (e.g. "ANNEMARIE BORLIND", "Annemarie Börlind", ...) in one
  // request. Takes precedence over `brand` when present.
  const brandsParam = searchParams.get("brands") ?? undefined;
  const brandIn = brandsParam
    ? brandsParam.split(",").map((b) => b.trim()).filter(Boolean)
    : undefined;
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
  // Opt-in flag (used by the All Offers page) to hide rows from the original
  // one-off bulk CSV import. Defaults to off so other consumers (Matrix,
  // Compare, History) keep seeing the full data set unless they ask.
  const excludeBulkImport = searchParams.get("excludeBulkImport") === "true";

  const { offers, total } = await listOffers({
    search,
    brand,
    brandIn,
    supplier,
    supplierIn,
    limit: effectiveLimit,
    offset,
    excludeBulkImport,
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
