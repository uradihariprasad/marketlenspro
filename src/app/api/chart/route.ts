/**
 * Chart + full analysis payload for one instrument/timeframe:
 * candles, indicators, structure events, S/R zones (provenance-separated),
 * volume profile, estimated order flow. All quality-labelled.
 */
import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/market/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TF = new Set([1, 2, 5, 10, 15, 30]);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("instrumentKey") ?? "";
  const tf = Number(searchParams.get("timeframe") ?? "5");
  if (!key) return NextResponse.json({ ok: false, error: "instrumentKey required" }, { status: 400 });
  const tfMin = ALLOWED_TF.has(tf) ? tf : 5;
  const e = await ensureBoot();
  try {
    const analysis = await e.getAnalysis(key, tfMin);
    // A request that yields no candles is a visible failure, not a blank chart.
    if (!analysis || analysis.candles.length === 0) {
      return NextResponse.json({
        ok: false,
        error: `Provider returned no candles for ${key} at ${tfMin}m — the instrument key may be invalid, the interval unsupported, or history unavailable.`,
        instrumentKey: key,
        timeframeMin: tfMin,
        candleCount: 0,
        asOf: Date.now(),
      }, { status: 422 });
    }
    const flow = e.flowFor(key, Math.min(tfMin, 5));
    // same shared CVD momentum the dominance tab / Trade Finder / alerts use
    const cvd = e.cvdMomentumFor(key, Math.min(tfMin, 5));
    // surface the true calculation source (spot index flow is proxied)
    const flowSource = e.resolveFlowSource(key);
    // unified immediate/primary S/R — the SAME object the chart and panels render
    const unifiedSR = e.getUnifiedSR(key);
    const chainKey = e.resolveChainKey(key);
    const chain = chainKey ? e.chainOptionsFor(chainKey) : null;
    const q = e.quotes.get(key) ?? null;
    return NextResponse.json({
      ok: true,
      analysis,
      cvd,
      unifiedSR,
      flowSource: {
        requestedKey: key,
        sourceKey: flowSource.sourceKey,
        sourceType: flowSource.sourceType,
        sourceLabel: flowSource.sourceLabel,
        contractExpiry: flowSource.contractExpiry,
        isProxy: flowSource.isProxy,
        reason: flowSource.reason,
      },
      candleCount: analysis.candles.length,
      firstCandleTs: analysis.candles[0]?.t ?? null,
      lastCandleTs: analysis.candles[analysis.candles.length - 1]?.t ?? null,
      flow,
      displayName: e.displayNameOf(key),
      connection: e.connectionState(),
      tokenStatus: e.getStatus().tokenStatus,
      chain: chain ? { underlyingKey: chain.underlyingKey, expiry: chain.expiry, pcrOi: chain.pcrOi, pcrVol: chain.pcrVol, maxPain: chain.maxPain, atmStrike: chain.atmStrike, rows: chain.rows.slice(0, 25), capturedAt: chain.capturedAt, refCapturedAt: chain.refCapturedAt, notes: chain.notes } : null,
      quote: q ? { ltp: q.ltp, changePct: q.ltp !== null && q.close ? Math.round(((q.ltp - q.close) / q.close) * 10000) / 100 : null, atp: q.atp, oi: q.oi, volumeCum: q.volumeCum, close: q.close, bids: q.bids ?? (q.bid ? [q.bid] : []), asks: q.asks ?? (q.ask ? [q.ask] : []), depthLevels: q.depthLevels, quality: q.quality, localTs: q.localTs } : null,
      asOf: Date.now(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "analysis failed";
    return NextResponse.json({ ok: false, error: message.slice(0, 200) }, { status: 502 });
  }
}
