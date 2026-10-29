/**
 * Focus route (Phase 4.11): the selected instrument drives stock-level option
 * chains and order-flow tracking. Prevents stale-instrument state by
 * re-pointing the engine's focus key.
 */
import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/market/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { instrumentKey?: string };
    const e = await ensureBoot();
    e.setFocus(body.instrumentKey ? String(body.instrumentKey) : null);
    return NextResponse.json({ ok: true, focusKey: e.focusKey });
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
}
