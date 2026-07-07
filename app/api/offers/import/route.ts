import { NextRequest, NextResponse } from "next/server";
import { createOffers } from "@/lib/db";
import { offersFromCsv } from "@/lib/csv";

export const dynamic = "force-dynamic";
// Allow more time for large CSV imports (up to what the Vercel plan permits;
// Hobby caps this at 60, Pro/Enterprise allow more - Vercel clamps it
// automatically so it's safe to just ask for the max).
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { csv } = (await req.json()) as { csv: string };

  if (!csv || typeof csv !== "string") {
    return NextResponse.json({ error: "No CSV content provided." }, { status: 400 });
  }

  const { offers, errors } = offersFromCsv(csv);
  const imported = offers.length > 0 ? await createOffers(offers) : 0;

  return NextResponse.json({ imported, errors });
}
