/**
 * Momentum classification tests (Prompt §1).
 *
 * The headline defect: `Math.sign(changePct || 1)` meant a stock with ZERO
 * price change and high RVOL scored strongly bullish and appeared as a
 * momentum leader. These tests lock that door.
 */
import { describe, it, expect } from "vitest";
import { buildScanner, Baseline } from "../src/lib/market/scanner";
import { InstrumentMeta, Quote } from "../src/lib/market/types";

function eq(symbol: string): InstrumentMeta {
  return { instrumentKey: `NSE_EQ|IN${symbol}`, tradingSymbol: symbol, name: symbol, segment: "NSE_EQ", instrumentType: "EQ", tickSize: 0.05 };
}
function quote(key: string, over: Partial<Quote> = {}): Quote {
  return {
    instrumentKey: key, source: "UPSTOX_REST_POLL",
    exchangeTs: 1000, lastTradeTs: 1000, localTs: Date.now(),
    ltp: 100, ltq: 10, volumeCum: 4_000_000, oi: null,
    open: 100, high: 101, low: 99, close: 100, atp: 100,
    bid: null, ask: null, depthLevels: 0, quality: "LIVE", netChange: null,
    ...over,
  };
}
const base: Baseline = { avgVol20: 800_000, atr14: 2 }; // ATR 2% of a 100 stock
const common = {
  baselines: new Map<string, Baseline>(),
  futInterpByEquity: new Map<string, string>(),
  proximityByEquity: new Map<string, string>(),
  niftyChangePct: 0,
  elapsedFraction: 0.5,
  now: Date.now(),
  minTurnoverCr: 25,
};

describe("false-positive momentum is eliminated", () => {
  it("ZERO price change + very high RVOL => NO_MOMENTUM, score 0, not a leader", () => {
    const k = "NSE_EQ|INFLAT";
    const out = buildScanner({
      ...common,
      universe: [eq("FLAT")],
      // ltp === prev close exactly, but 10x the expected volume
      quotes: new Map([[k, quote(k, { ltp: 100, close: 100, volumeCum: 40_000_000 })]]),
      baselines: new Map([[k, base]]),
    });
    expect(out.bullish.find((r) => r.symbol === "FLAT")).toBeUndefined();
    expect(out.bearish.find((r) => r.symbol === "FLAT")).toBeUndefined();
    // it is still a legitimate PARTICIPATION entry
    const rv = out.rvolLeaders.find((r) => r.symbol === "FLAT");
    expect(rv).toBeDefined();
    expect(rv!.momentum?.classification).toBe("NO_MOMENTUM");
    expect(rv!.score).toBe(0);
    expect(rv!.exclusions.some((e) => e.includes("participation is not momentum"))).toBe(true);
  });

  it("tiny sub-ATR drift with huge RVOL is not a momentum leader", () => {
    const k = "NSE_EQ|INDRIFT";
    const out = buildScanner({
      ...common,
      universe: [eq("DRIFT")],
      // +0.1% move against a 2% ATR => 0.05 ATR, far below threshold
      quotes: new Map([[k, quote(k, { ltp: 100.1, close: 100, volumeCum: 40_000_000 })]]),
      baselines: new Map([[k, base]]),
    });
    expect(out.bullish).toHaveLength(0);
    const row = out.rvolLeaders[0];
    expect(row.momentum?.classification).toBe("NO_MOMENTUM");
    expect(row.score).toBe(0);
  });

  it("genuine directional move with volume confirmation IS a confirmed leader", () => {
    const k = "NSE_EQ|INREAL";
    const out = buildScanner({
      ...common,
      universe: [eq("REAL")],
      // +3% on a 2% ATR stock (1.5 ATR) with 10x volume and RS vs flat NIFTY
      quotes: new Map([[k, quote(k, { ltp: 103, close: 100, atp: 101.5, volumeCum: 40_000_000 })]]),
      baselines: new Map([[k, base]]),
    });
    const row = out.bullish[0];
    expect(row).toBeDefined();
    expect(row.symbol).toBe("REAL");
    expect(row.momentum?.classification).toBe("CONFIRMED_BULLISH");
    expect(row.momentum?.direction).toBe(1);
    expect(row.score).toBeGreaterThan(2);
    expect(row.momentum?.atrMove).toBeCloseTo(1.5, 1);
  });

  it("genuine downside move classifies bearish, never bullish", () => {
    const k = "NSE_EQ|INDOWN";
    const out = buildScanner({
      ...common,
      universe: [eq("DOWN")],
      quotes: new Map([[k, quote(k, { ltp: 97, close: 100, atp: 98.5, volumeCum: 40_000_000 })]]),
      baselines: new Map([[k, base]]),
    });
    expect(out.bullish).toHaveLength(0);
    const row = out.bearish[0];
    expect(row.momentum?.direction).toBe(-1);
    expect(row.score).toBeLessThan(0);
    expect(row.momentum?.classification).toMatch(/BEARISH/);
  });

  it("directional move WITHOUT confirmation is a candidate, ranked below confirmed", () => {
    const strong = "NSE_EQ|INSTRONG";
    const weak = "NSE_EQ|INWEAK";
    const out = buildScanner({
      ...common,
      universe: [eq("STRONG"), eq("WEAK")],
      quotes: new Map([
        // confirmed: big move + high volume
        [strong, quote(strong, { ltp: 103, close: 100, atp: 101.5, volumeCum: 40_000_000 })],
        // candidate: smaller move, only baseline volume
        [weak, quote(weak, { ltp: 100.8, close: 100, atp: 100.4, volumeCum: 4_000_000 })],
      ]),
      baselines: new Map([[strong, base], [weak, base]]),
    });
    expect(out.bullish[0].symbol).toBe("STRONG"); // confirmed outranks candidate
    expect(out.bullish[0].momentum?.classification).toBe("CONFIRMED_BULLISH");
    const w = out.bullish.find((r) => r.symbol === "WEAK");
    if (w) expect(w.momentum?.classification).not.toBe("CONFIRMED_BULLISH");
  });

  it("RVOL alone can never flip direction (participation is unsigned)", () => {
    const k = "NSE_EQ|INNEG";
    const out = buildScanner({
      ...common,
      universe: [eq("NEG")],
      // negative move but enormous volume — must stay bearish
      quotes: new Map([[k, quote(k, { ltp: 96, close: 100, atp: 97, volumeCum: 80_000_000 })]]),
      baselines: new Map([[k, base]]),
    });
    expect(out.bullish).toHaveLength(0);
    expect(out.bearish[0].score).toBeLessThan(0);
  });

  it("stale quotes are excluded with a reason, not silently scored", () => {
    const k = "NSE_EQ|INSTALE";
    const now = Date.now();
    const out = buildScanner({
      ...common,
      now,
      universe: [eq("STALE")],
      quotes: new Map([[k, quote(k, { ltp: 105, close: 100, localTs: now - 300_000 })]]),
      baselines: new Map([[k, base]]),
      staleMs: 60_000,
    });
    expect(out.bullish).toHaveLength(0);
    expect(out.coverage.stale).toBe(1);
    expect(out.rejected.some((r) => r.symbol === "STALE" && r.reason.includes("stale"))).toBe(true);
  });

  it("missing ATR baseline still works via the absolute-move floor", () => {
    const k = "NSE_EQ|INNOATR";
    const out = buildScanner({
      ...common,
      universe: [eq("NOATR")],
      quotes: new Map([[k, quote(k, { ltp: 103, close: 100, atp: 101.5, volumeCum: 40_000_000 })]]),
      baselines: new Map([[k, { avgVol20: 800_000, atr14: null }]]),
    });
    const row = out.bullish[0] ?? out.rvolLeaders[0];
    expect(row.momentum?.direction).toBe(1);
    expect(row.momentum?.atrMove).toBeNull(); // ATR unavailable — reported, not faked
  });

  it("momentum and liquidity rankings are independent lists", () => {
    const mover = "NSE_EQ|INMOVER";
    const flat = "NSE_EQ|INFLATBIG";
    const out = buildScanner({
      ...common,
      universe: [eq("MOVER"), eq("FLATBIG")],
      quotes: new Map([
        [mover, quote(mover, { ltp: 103, close: 100, atp: 101.5, volumeCum: 10_000_000 })],
        // flat but by far the most traded
        [flat, quote(flat, { ltp: 100, close: 100, volumeCum: 90_000_000 })],
      ]),
      baselines: new Map([[mover, base], [flat, base]]),
    });
    expect(out.bullish.map((r) => r.symbol)).toContain("MOVER");
    expect(out.bullish.map((r) => r.symbol)).not.toContain("FLATBIG");
    expect(out.liquid[0].symbol).toBe("FLATBIG"); // liquidity board is unaffected
  });

  it("exposes a transparent score breakdown for every stock", () => {
    const k = "NSE_EQ|INREAL";
    const out = buildScanner({
      ...common,
      universe: [eq("REAL")],
      quotes: new Map([[k, quote(k, { ltp: 103, close: 100, atp: 101.5, volumeCum: 40_000_000 })]]),
      baselines: new Map([[k, base]]),
    });
    const bd = out.bullish[0].momentum!.breakdown;
    expect(bd.length).toBeGreaterThanOrEqual(5);
    const sum = bd.reduce((a, b) => a + b.v, 0);
    expect(sum).toBeCloseTo(out.bullish[0].score, 3); // breakdown explains the score
  });
});
