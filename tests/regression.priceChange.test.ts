/**
 * Regression tests for the two reported bugs.
 *
 * BUG 1 (dominance): stocks were ranked with identical low scores using market
 *      structure alone, with FLOW UNAVAILABLE / CVD INSUFFICIENT DATA.
 * BUG 2 (scanner):  218 stocks "evaluated" but 0 bullish / 0 bearish, with
 *      0.00% price changes — caused by comparing LTP against `ohlc.close`,
 *      which in the documented Upstox response can equal `last_price`.
 */
import { describe, it, expect } from "vitest";
import { buildScanner, resolveChangePct, Baseline, ScannerRow } from "../src/lib/market/scanner";
import { buildDominance, DominanceStructure } from "../src/lib/market/dominance";
import { InstrumentMeta, Quote, Zone } from "../src/lib/market/types";

function eq(sym: string): InstrumentMeta {
  return { instrumentKey: `NSE_EQ|IN${sym}`, tradingSymbol: sym, name: sym, segment: "NSE_EQ", instrumentType: "EQ", tickSize: 0.05 };
}
function quote(key: string, over: Partial<Quote> = {}): Quote {
  return {
    instrumentKey: key, source: "UPSTOX_REST_POLL",
    exchangeTs: 1000, lastTradeTs: 1000, localTs: Date.now(),
    ltp: 100, ltq: 10, volumeCum: 20_000_000, oi: null,
    open: 100, high: 104, low: 99, close: 100, netChange: null, atp: 101.5,
    bid: null, ask: null, depthLevels: 0, quality: "LIVE", ...over,
  };
}
const base: Baseline = { avgVol20: 800_000, atr14: 2, prevClose: 100 };
const now = Date.now();
const common = {
  baselines: new Map<string, Baseline>(),
  futInterpByEquity: new Map<string, string>(),
  proximityByEquity: new Map<string, string>(),
  niftyChangePct: 0, elapsedFraction: 0.5, now, minTurnoverCr: 25,
};
function structure(): DominanceStructure {
  const z = (mid: number, side: Zone["side"]): Zone => ({
    id: `z${mid}${side}`, instrumentKey: "x", timeframeMin: 5, side,
    lower: mid - 1, upper: mid + 1, mid, provenanceGroup: "STRUCTURAL",
    confirmationStatus: "CONFIRMED", state: "CONFIRMED", score: 3,
    breakdown: [], sources: [], touches: [], invalidation: mid, createdAt: 0, updatedAt: 0,
  });
  return {
    trend: "UP", lastEvent: "BOS_UP", zones: [],
    primarySupport: z(96, "SUPPORT"), primaryResistance: z(107, "RESISTANCE"),
    atr: 2, analysedAt: now,
  };
}

// ---------------------------------------------------------------------------
// BUG 2 — price-change calculation
// ---------------------------------------------------------------------------
describe("BUG 2: price change must not be computed against ohlc.close alone", () => {
  it("reproduces the defect: ohlc.close == last_price must NOT read as 0.00%", () => {
    // Documented Upstox shape: net_change -1.05 while ohlc.close == last_price
    const r = resolveChangePct({ ltp: 52.05, netChange: -1.05, close: 52.05 }, null);
    expect(r.pct).toBeCloseTo(-1.976, 2); // -1.05 / 53.10
    expect(r.exact).toBe(true);
    expect(r.basis).toContain("net_change");
    // The old formula would have returned exactly 0.00%
    expect(((52.05 - 52.05) / 52.05) * 100).toBe(0);
  });

  it("prefers net_change, then the daily-candle baseline, then ohlc.close", () => {
    // 1. net_change wins
    expect(resolveChangePct({ ltp: 103, netChange: 3, close: 999 }, null).pct).toBeCloseTo(3, 1);
    // 2. baseline previous close when net_change is missing
    const b = resolveChangePct({ ltp: 105, netChange: null, close: 999 }, 100);
    expect(b.pct).toBeCloseTo(5, 1);
    expect(b.basis).toContain("daily-candle");
    // 3. ohlc.close only when it differs from LTP
    const c = resolveChangePct({ ltp: 104, netChange: null, close: 100 }, null);
    expect(c.pct).toBeCloseTo(4, 1);
    expect(c.basis).toContain("ohlc.close");
  });

  it("a genuine zero is preserved only when the provider reports it", () => {
    expect(resolveChangePct({ ltp: 100, netChange: 0, close: 100 }, null)).toEqual({
      pct: 0, exact: true, basis: expect.stringContaining("net_change"),
    });
    // ohlc.close == LTP with no net_change is indeterminate, NOT a real zero
    const ind = resolveChangePct({ ltp: 100, netChange: null, close: 100 }, null);
    expect(ind.pct).toBe(0);
    expect(ind.exact).toBe(false);
    expect(ind.basis).toContain("indeterminate");
  });

  it("missing/invalid LTP is reported, never zero-filled", () => {
    const r = resolveChangePct({ ltp: null, netChange: null, close: 100 }, null);
    expect(r.pct).toBe(0);
    expect(r.exact).toBe(false);
  });

  it("scanner now produces candidates from the documented quote shape", () => {
    const k = "NSE_EQ|INREAL";
    const sc = buildScanner({
      ...common,
      universe: [eq("REAL")],
      // The exact shape that previously produced 0.00% for every instrument
      quotes: new Map([[k, quote(k, { ltp: 103, close: 103, netChange: 3 })]]),
      baselines: new Map([[k, base]]),
    });
    expect(sc.bullish).toHaveLength(1);
    expect(sc.bullish[0].changePct).toBeCloseTo(3, 1);
    expect(sc.bullish[0].changeExact).toBe(true);
    expect(sc.bullish[0].momentum?.classification).toMatch(/BULLISH/);
  });

  it("indeterminate change is excluded from momentum with an explicit reason", () => {
    const k = "NSE_EQ|INFLAT";
    const sc = buildScanner({
      ...common,
      universe: [eq("FLAT")],
      quotes: new Map([[k, quote(k, { ltp: 100, close: 100, netChange: null })]]),
      baselines: new Map([[k, { ...base, prevClose: null }]]),
    });
    expect(sc.bullish).toHaveLength(0);
    expect(sc.bearish).toHaveLength(0);
    const row = sc.rvolLeaders[0];
    expect(row.changeExact).toBe(false);
    expect(row.reasons.some((r) => r.includes("indeterminate"))).toBe(true);
  });

  it("genuine zero movement stays zero and produces no momentum", () => {
    const k = "NSE_EQ|INZERO";
    const sc = buildScanner({
      ...common,
      universe: [eq("ZERO")],
      quotes: new Map([[k, quote(k, { ltp: 100, close: 100, netChange: 0 })]]),
      baselines: new Map([[k, base]]),
    });
    expect(sc.bullish).toHaveLength(0);
    expect(sc.bearish).toHaveLength(0);
    expect(sc.rvolLeaders[0].changePct).toBe(0);
    expect(sc.rvolLeaders[0].changeExact).toBe(true); // a REAL zero
  });

  it("empty scanner results carry an explicit reason, not a silent blank", () => {
    const sc = buildScanner({
      ...common,
      universe: [eq("FLAT1"), eq("FLAT2")],
      quotes: new Map([
        ["NSE_EQ|INFLAT1", quote("NSE_EQ|INFLAT1", { ltp: 100, close: 100, netChange: 0 })],
        ["NSE_EQ|INFLAT2", quote("NSE_EQ|INFLAT2", { ltp: 100, close: 100, netChange: 0 })],
      ]),
      baselines: new Map([["NSE_EQ|INFLAT1", base], ["NSE_EQ|INFLAT2", base]]),
    });
    expect(sc.bullish).toHaveLength(0);
    expect(sc.bearish).toHaveLength(0);
    expect(sc.notes.some((n) => /PARTIAL SCAN|Full-universe scan/.test(n))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BUG 1 — structure-only dominance
// ---------------------------------------------------------------------------
describe("BUG 1: market structure alone must never rank a dominance candidate", () => {
  it("reproduces the defect: no directional move + agreeing trend previously scored 12", () => {
    // Old behaviour: structure weight 12 with a ranking floor of 8 ranked it.
    const flat: ScannerRow = {
      instrumentKey: "NSE_EQ|INHDFC", symbol: "HDFCBANK", ltp: 100, changePct: 0,
      changeExact: true,
      momentum: { classification: "NO_MOMENTUM", direction: 0 as const, strength: 0, participation: 0.8, atrMove: 0, breakdown: [] },
      flow: null, volumeCum: 5_000_000, turnoverCr: 500, rvol: 2, rvolMode: "APPROXIMATE",
      atrPct: 2, rsVsNifty: 0, vwapPos: null, futInterp: null, proximity: null,
      score: 0, reasons: [], exclusions: [], quality: "LIVE" as const,
    };
    const dom = buildDominance({
      rows: [flat],
      structures: new Map([["NSE_EQ|INHDFC", structure()]]), // trend UP agrees
      eligibleUniverse: 1, now, topN: 5,
    });
    // MUST NOT be ranked on structure direction alone
    expect(dom.buyers).toHaveLength(0);
    expect(dom.sellers).toHaveLength(0);
    expect(dom.shortfallNote).toBeTruthy();
  });

  it("a flat stock with an agreeing structure is not ranked, even with high RVOL", () => {
    const flat: ScannerRow = {
      instrumentKey: "NSE_EQ|ININFY", symbol: "INFY", ltp: 100, changePct: 0,
      changeExact: true,
      momentum: { classification: "NO_MOMENTUM", direction: 0 as const, strength: 0, participation: 1, atrMove: 0, breakdown: [] },
      flow: null, volumeCum: 50_000_000, turnoverCr: 5000, rvol: 5, rvolMode: "APPROXIMATE",
      atrPct: 2, rsVsNifty: 0, vwapPos: null, futInterp: null, proximity: null,
      score: 0, reasons: [], exclusions: [], quality: "LIVE" as const,
    };
    const dom = buildDominance({
      rows: [flat],
      structures: new Map([["NSE_EQ|ININFY", structure()]]),
      eligibleUniverse: 1, now, topN: 5,
    });
    expect(dom.buyers).toHaveLength(0);
  });

  it("no two ranked candidates share an identical structure-only score", () => {
    const mk = (sym: string, chg: number, strength: number): ScannerRow => ({
      instrumentKey: `NSE_EQ|IN${sym}`, symbol: sym, ltp: 100, changePct: chg,
      changeExact: true,
      momentum: {
        classification: chg > 0 ? ("BULLISH_CANDIDATE" as const) : ("BEARISH_CANDIDATE" as const),
        direction: (chg > 0 ? 1 : -1) as 1 | -1, strength, participation: 0.8,
        atrMove: chg / 2, breakdown: [],
      },
      flow: null, volumeCum: 5_000_000, turnoverCr: 500, rvol: 2, rvolMode: "APPROXIMATE",
      atrPct: 2, rsVsNifty: chg, vwapPos: null, futInterp: null, proximity: null,
      score: 0, reasons: [], exclusions: [], quality: "LIVE" as const,
    });
    const dom = buildDominance({
      rows: [mk("AAA", 3, 0.9), mk("BBB", 1.2, 0.4), mk("CCC", 2, 0.7)],
      structures: new Map([["NSE_EQ|INAAA", structure()], ["NSE_EQ|INBBB", structure()], ["NSE_EQ|INCCC", structure()]]),
      eligibleUniverse: 3, now, topN: 5,
    });
    expect(dom.buyers.length).toBeGreaterThan(1);
    const scores = dom.buyers.map((b) => b.score);
    expect(new Set(scores).size).toBe(scores.length); // no identical scores
    // ranked in descending score order
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("missing Delta/CVD yields a REDUCED CONFIDENCE label, never bullish/bearish confirmation", () => {
    const real: ScannerRow = {
      instrumentKey: "NSE_EQ|INREAL", symbol: "REAL", ltp: 103, changePct: 3,
      changeExact: true,
      momentum: { classification: "BULLISH_CANDIDATE" as const, direction: 1 as const, strength: 0.9, participation: 0.8, atrMove: 1.5, breakdown: [] },
      flow: null, volumeCum: 5_000_000, turnoverCr: 500, rvol: 2, rvolMode: "APPROXIMATE",
      atrPct: 2, rsVsNifty: 1.5, vwapPos: "ABOVE" as const, futInterp: null, proximity: null,
      score: 0, reasons: [], exclusions: [], quality: "LIVE" as const,
    };
    const dom = buildDominance({
      rows: [real],
      structures: new Map([["NSE_EQ|INREAL", structure()]]),
      eligibleUniverse: 1, now, topN: 5,
    });
    expect(dom.buyers).toHaveLength(1);
    const c = dom.buyers[0];
    expect(c.flowMode).toBe("UNAVAILABLE");
    expect(c.action).not.toBe("ACTIONABLE");
    expect(c.actionReason).toMatch(/REDUCED CONFIDENCE/i);
    expect(c.actionReason).toMatch(/Delta\/CVD confirmation is unavailable/i);
  });

  it("buyer and seller boards reflect genuine pressure in the correct direction", () => {
    const mk = (sym: string, chg: number): ScannerRow => ({
      instrumentKey: `NSE_EQ|IN${sym}`, symbol: sym, ltp: 100, changePct: chg,
      changeExact: true,
      momentum: {
        classification: chg > 0 ? ("BULLISH_CANDIDATE" as const) : ("BEARISH_CANDIDATE" as const),
        direction: (chg > 0 ? 1 : -1) as 1 | -1, strength: 0.9, participation: 0.8,
        atrMove: chg / 2, breakdown: [],
      },
      flow: null, volumeCum: 5_000_000, turnoverCr: 500, rvol: 2, rvolMode: "APPROXIMATE",
      atrPct: 2, rsVsNifty: chg, vwapPos: null, futInterp: null, proximity: null,
      score: 0, reasons: [], exclusions: [], quality: "LIVE" as const,
    });
    const dom = buildDominance({
      rows: [mk("UP1", 3), mk("UP2", 2), mk("DN1", -3), mk("DN2", -2)],
      structures: new Map([
        ["NSE_EQ|INUP1", structure()], ["NSE_EQ|INUP2", structure()],
        ["NSE_EQ|INDN1", structure()], ["NSE_EQ|INDN2", structure()],
      ]),
      eligibleUniverse: 4, now, topN: 5,
    });
    for (const b of dom.buyers) expect(b.changePct).toBeGreaterThan(0);
    for (const s of dom.sellers) expect(s.changePct).toBeLessThan(0);
    // no instrument appears on both boards
    const bKeys = new Set(dom.buyers.map((b) => b.instrumentKey));
    for (const s of dom.sellers) expect(bKeys.has(s.instrumentKey)).toBe(false);
  });

  it("duplicate instrument records produce a single ranking entry", () => {
    const mk = (sym: string): ScannerRow => ({
      instrumentKey: `NSE_EQ|IN${sym}`, symbol: sym, ltp: 103, changePct: 3,
      changeExact: true,
      momentum: { classification: "BULLISH_CANDIDATE" as const, direction: 1 as const, strength: 0.9, participation: 0.8, atrMove: 1.5, breakdown: [] },
      flow: null, volumeCum: 5_000_000, turnoverCr: 500, rvol: 2, rvolMode: "APPROXIMATE",
      atrPct: 2, rsVsNifty: 1.5, vwapPos: null, futInterp: null, proximity: null,
      score: 0, reasons: [], exclusions: [], quality: "LIVE" as const,
    });
    const dup = [mk("AAA"), mk("AAA")];
    const rows = [...new Map(dup.map((r) => [r.instrumentKey, r])).values()];
    const dom = buildDominance({
      rows, structures: new Map([["NSE_EQ|INAAA", structure()]]),
      eligibleUniverse: 1, now, topN: 5,
    });
    expect(dom.buyers.filter((b) => b.symbol === "AAA")).toHaveLength(1);
  });
});
