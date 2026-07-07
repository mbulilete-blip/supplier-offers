import { NextResponse } from "next/server";
import { listSuppliers } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const suppliers = await listSuppliers();
  return NextResponse.json(suppliers);
}
