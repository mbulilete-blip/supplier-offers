import { NextResponse } from "next/server";
import { fixNumericBrands } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One-off maintenance endpoint: repairs offer rows whose "brand" field was
// accidentally set to a barcode number, or duplicated from the product name,
// during the bulk import (a few source sheets had misaligned columns).
// Idempotent - safe to call again.
export async function POST() {
  const result = await fixNumericBrands();
  return NextResponse.json(result);
}
