import { NextRequest, NextResponse } from "next/server";
import { renameSupplier } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : "";

  if (!from.trim() || !to.trim()) {
    return NextResponse.json(
      { error: "Both the current and new supplier name are required." },
      { status: 400 }
    );
  }

  const updated = await renameSupplier(from, to);
  return NextResponse.json({ updated });
}
