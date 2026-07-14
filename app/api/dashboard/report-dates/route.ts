import { NextResponse } from "next/server";
import { listReportDates } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const dates = await listReportDates();
  return NextResponse.json(dates);
}
