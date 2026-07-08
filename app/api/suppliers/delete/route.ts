import { NextRequest, NextResponse } from "next/server";
import { deleteOffersBySupplierAndBrand } from "@/lib/db";

export const dynamic = "force-dynamic";

// Deletes every offer from one supplier within one brand - powers the
// "delete this column" action on the Matrix page.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const supplier = typeof body.supplier === "string" ? body.supplier : "";
  const brand = typeof body.brand === "string" ? body.brand : "";

  if (!supplier.trim() || !brand.trim()) {
    return NextResponse.json(
      { error: "Both supplier and brand are required." },
      { status: 400 }
    );
  }

  const deleted = await deleteOffersBySupplierAndBrand(supplier, brand);
  return NextResponse.json({ deleted });
}
