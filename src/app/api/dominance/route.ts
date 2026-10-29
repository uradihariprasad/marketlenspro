/**
 * Buyer / Seller Dominance rankings.
 *
 * Serves the engine's shared scanner + order-flow + structure state. No extra
 * provider requests are made here: the route reads already-polled, validated
 * data so the tab, chart, S/R engine and Trade Finder stay consistent.
 */
import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/market/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const topN = Math.min(10, Math.max(1, Number(searchParams.get("topN") ?? "5") || 5));

  const e = await ensureBoot();
  const status = e.getStatus();
  const dom = e.getDominance(topN);

  if (!dom) {
    return NextResponse.json({
      ok: false,
      state: status.tokenStatus === "VALID" ? "PENDING" : "REQUIRES_TOKEN",
      reason:
        status.tokenStatus === "VALID"
          ? "The scanner has not completed its first cycle yet — dominance needs fresh quotes."
          : "Buyer/Seller dominance needs live quotes: connect an Upstox access token.",
      marketPhase: status.marketPhase,
      asOf: Date.now(),
    });
  }

  return NextResponse.json({
    ok: true,
    state: "LOADED",
    dominance: dom,
    marketPhase: status.marketPhase,
    tokenStatus: status.tokenStatus,
    scanAt: status.scanAt ?? null,
    asOf: Date.now(),
  });
}
