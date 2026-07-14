import { NextRequest, NextResponse } from "next/server";
import { getDailyReport } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date query param required as YYYY-MM-DD." }, { status: 400 });
  }
  const report = await getDailyReport(date);
  return NextResponse.json(report);
}
