import { NextRequest, NextResponse } from "next/server";
import { createOffers } from "@/lib/db";
import { offersFromCsv } from "@/lib/csv";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { csv } = (await req.json()) as { csv: string };

  if (!csv || typeof csv !== "string") {
    return NextResponse.json({ error: "No CSV content provided." }, { status: 400 });
  }

  const { offers, errors } = offersFromCsv(csv);
  const imported = offers.length > 0 ? await createOffers(offers) : 0;

  return NextResponse.json({ imported, errors });
}
