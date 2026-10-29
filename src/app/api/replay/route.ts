/**
 * Historical Replay & EOD analytics (Phase 4.10 / Phase 5.8).
 * GET ?instrumentKey=...&date=YYYY-MM-DD&timeframe=5
 * Runs the canonical analysis pipeline (structure → S/R → scenario engine)
 * step-by-step over strictly-prefix candle sets — no look-ahead by
 * construction — and scores each unique candidate against remaining bars.
 */
import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/market/engine";
import { runReplay } from "@/lib/market/replay";
import { istDateKey } from "@/lib/market/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("instrumentKey") ?? "";
  let date = searchParams.get("date") ?? "";
  const tf = Math.min(30, Math.max(1, Number(searchParams.get("timeframe") ?? "5") || 5));
  if (!key) return NextResponse.json({ ok: false, error: "instrumentKey required" }, { status: 400 });
  const e = await ensureBoot();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    // default: previous trading session (= most recent weekday before today)
    const d = new Date(Date.now() - 86_400_000);
    while ([0, 6].includes(new Date(d.getTime() + 5.5 * 3600_000).getUTCDay())) d.setTime(d.getTime() - 86_400_000);
    date = istDateKey(d.getTime());
  }
  try {
    const oneMin = await e.getOneMinHistory(key);
    const tick = 0.05;
    const result = runReplay({ instrumentKey: key, oneMin, timeframeMin: tf, tickSize: tick, sessionDate: date });
    if ("error" in result) return NextResponse.json({ ok: false, error: result.error, date }, { status: 422 });
    return NextResponse.json({ ok: true, replay: result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message.slice(0, 160) }, { status: 500 });
  }
}
