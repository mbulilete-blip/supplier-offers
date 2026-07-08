import { NextRequest, NextResponse } from "next/server";
import { listSuppliers, listSupplierGroups } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get("grouped") === "true") {
    const groups = await listSupplierGroups();
    return NextResponse.json(groups);
  }
  const suppliers = await listSuppliers();
  return NextResponse.json(suppliers);
}
