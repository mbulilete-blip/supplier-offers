import { NextRequest, NextResponse } from "next/server";
import { getRecentOffers } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 10;
  const offers = await getRecentOffers(Number.isNaN(limit) ? 10 : limit);
  return NextResponse.json(offers);
}
