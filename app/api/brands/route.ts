import { NextResponse } from "next/server";
import { listBrands } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const brands = await listBrands();
  return NextResponse.json(brands);
}
