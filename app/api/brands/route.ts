import { NextRequest, NextResponse } from "next/server";
import { listBrands, listBrandGroups } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get("grouped") === "true") {
    const groups = await listBrandGroups();
    return NextResponse.json(groups);
  }
  const brands = await listBrands();
  return NextResponse.json(brands);
}
