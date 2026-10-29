/**
 * OI Strike Intelligence.
 *
 * Serves the engine's timestamped OI observation windows, strike ladder,
 * positioning postures, momentum state and OI-derived candidate zones.
 * Reads already-polled shared state — no extra provider requests are made
 * here, so this tab stays consistent with the chain, Delta/CVD and S/R views.
 */
import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/market/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("instrumentKey") ?? "";
  if (!key) {
    return NextResponse.json({ ok: false, state: "FAILED", error: "instrumentKey required" }, { status: 400 });
  }

  const e = await ensureBoot();
  // prioritise this underlying on the next chain scheduler pass
  e.setFocus(key);

  const result = e.getOiIntelligence(key);
  if ("error" in result) {
    return NextResponse.json({
      ok: false,
      state: result.state,
      error: result.error,
      tokenStatus: e.getStatus().tokenStatus,
      asOf: Date.now(),
    });
  }

  return NextResponse.json({
    ok: true,
    state: "LOADED",
    oi: result,
    tokenStatus: e.getStatus().tokenStatus,
    marketPhase: e.getStatus().marketPhase,
    asOf: Date.now(),
  });
}
