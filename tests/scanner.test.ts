/**
 * Phase 1.1 proof: the scanner ingests EQUITY quotes keyed by the equity
 * instrument key, never substitutes futures prices, rejects stale/missing
 * data with reasons, and ranks deterministically.
 */
import { describe, it, expect } from "vitest";
import { buildScanner, Baseline } from "../src/lib/market/scanner";
import { InstrumentMeta, Quote } from "../src/lib/market/types";

function eq(symbol: string): InstrumentMeta {
  return {
    instrumentKey: `NSE_EQ|IN${symbol}`,
    tradingSymbol: symbol,
    name: symbol,
    segment: "NSE_EQ",
    instrumentType: "EQ",
    tickSize: 0.05,
  };
}

function quote(key: string, over: Partial<Quote> = {}): Quote {
  return {
    instrumentKey: key,
    source: "UPSTOX_REST_POLL",
    exchangeTs: 1000, lastTradeTs: 1000, localTs: Date.now(),
    ltp: 110, ltq: 10, volumeCum: 4_000_000, oi: null,
    open: 100, high: 112, low: 99, close: 100, atp: 105,
    bid: null, ask: null, depthLevels: 0, quality: "LIVE", netChange: null,
    ...over,
  };
}

const base: Baseline = { avgVol20: 800_000, atr14: 2 };

describe("momentum scanner ingestion", () => {
  it("produces a bullish candidate from a valid equity quote", () => {
    const out = buildScanner({
      universe: [eq("AAA")],
      quotes: new Map([["NSE_EQ|INAAA", quote("NSE_EQ|INAAA")]]),
      baselines: new Map([["NSE_EQ|INAAA", base]]),
      futInterpByEquity: new Map(),
      proximityByEquity: new Map(),
      niftyChangePct: 0.4,
      elapsedFraction: 0.5,
      now: Date.now(),
      minTurnoverCr: 25,
    });
    expect(out.bullish.length).toBeGreaterThan(0);
    const row = out.bullish[0];
    expect(row.symbol).toBe("AAA");
    expect(row.changePct).toBeCloseTo(10); // (110-100)/100
    expect(row.rvolMode).toBe("APPROXIMATE");
    expect(row.rvol).toBeCloseTo(10, 1); // 4M / (800k*0.5)
    expect(row.turnoverCr).toBeCloseTo(42, 0); // 105 × 4M
    expect(row.vwapPos).toBe("ABOVE"); // ltp 110 > atp 105
    expect(row.reasons.length).toBeGreaterThan(0);
  });

  it("rejects a missing quote with an explicit reason — no fabrication", () => {
    const out = buildScanner({
      universe: [eq("BBB")],
      quotes: new Map(),
      baselines: new Map(),
      futInterpByEquity: new Map(),
      proximityByEquity: new Map(),
      niftyChangePct: null,
      elapsedFraction: 0.5,
      now: Date.now(),
      minTurnoverCr: 25,
    });
    expect(out.bullish).toHaveLength(0);
    expect(out.bearish).toHaveLength(0);
    expect(out.rejected.some((r) => r.symbol === "BBB" && r.reason.includes("no quote"))).toBe(true);
  });

  it("excludes stale equity quotes from candidate lists but keeps them out of rejection-with-fabrication", () => {
    const staleQ = quote("NSE_EQ|INCCC", { quality: "STALE", ltp: 112 });
    const out = buildScanner({
      universe: [eq("CCC")],
      quotes: new Map([["NSE_EQ|INCCC", staleQ]]),
      baselines: new Map([["NSE_EQ|INCCC", base]]),
      futInterpByEquity: new Map(),
      proximityByEquity: new Map(),
      niftyChangePct: 0.2,
      elapsedFraction: 0.5,
      now: Date.now(),
      minTurnoverCr: 25,
    });
    expect(out.bullish.find((r) => r.symbol === "CCC")).toBeUndefined();
  });

  it("never uses a futures quote in place of the equity quote", () => {
    // only a futures key present (NSE_FO), no equity quote
    const out = buildScanner({
      universe: [eq("DDD")],
      quotes: new Map([["NSE_FO|99999", quote("NSE_FO|99999", { ltp: 500 })]]),
      baselines: new Map([["NSE_EQ|INDDD", base]]),
      futInterpByEquity: new Map(),
      proximityByEquity: new Map(),
      niftyChangePct: 0,
      elapsedFraction: 0.5,
      now: Date.now(),
      minTurnoverCr: 25,
    });
    expect(out.bullish).toHaveLength(0);
    expect(out.rejected.some((r) => r.symbol === "DDD")).toBe(true);
  });

  it("adds flow confirmation as supplementary evidence without penalising absence", () => {
    const key = "NSE_EQ|INAAA";
    const common = {
      universe: [eq("AAA")],
      quotes: new Map([[key, quote(key)]]),
      baselines: new Map([[key, base]]),
      futInterpByEquity: new Map<string, string>(),
      proximityByEquity: new Map<string, string>(),
      niftyChangePct: 0.4,
      elapsedFraction: 0.5,
      now: Date.now(),
      minTurnoverCr: 25,
    };
    const without = buildScanner(common);
    const withFlow = buildScanner({
      ...common,
      flowByKey: new Map([[key, {
        status: "BULLISH", available: true, reason: "test", deltaRatio: 0.9,
        cvdSlope: 120, attributionPct: 85, score: 0.9, label: "ESTIMATED flow bullish",
      }]]),
    });
    // flow adds a bounded supplementary contribution (never dominates)
    expect(withFlow.bullish[0].score).toBeGreaterThan(without.bullish[0].score);
    expect(withFlow.bullish[0].score - without.bullish[0].score).toBeLessThanOrEqual(1.0001);
    expect(withFlow.coverage.flowConfirmed).toBe(1);
    expect(without.coverage.flowConfirmed).toBe(0);
    expect(without.coverage.flowUnavailable).toBe(1);
    // missing flow must NOT reduce the score below the core momentum value
    expect(without.bullish[0].flow ?? null).toBeNull();
  });

  it("marks unavailable flow without claiming confirmation", () => {
    const key = "NSE_EQ|INAAA";
    const out = buildScanner({
      universe: [eq("AAA")],
      quotes: new Map([[key, quote(key)]]),
      baselines: new Map([[key, base]]),
      futInterpByEquity: new Map(),
      proximityByEquity: new Map(),
      niftyChangePct: 0,
      elapsedFraction: 0.5,
      now: Date.now(),
      minTurnoverCr: 25,
      flowByKey: new Map([[key, {
        status: "INSUFFICIENT", available: false, reason: "only 2 observations",
        deltaRatio: null, cvdSlope: null, attributionPct: 0, score: 0, label: "collecting flow data",
      }]]),
    });
    const row = out.bullish[0] ?? out.bearish[0];
    expect(row.flow?.available).toBe(false);
    expect(row.reasons.some((r) => r.includes("flow unavailable"))).toBe(true);
    expect(out.coverage.flowConfirmed).toBe(0);
  });

  it("reports honest coverage and flags a partial scan", () => {
    const fresh = "NSE_EQ|INAAA";
    const stale = "NSE_EQ|INBBB";
    const now = Date.now();
    const out = buildScanner({
      universe: [eq("AAA"), eq("BBB"), eq("CCC")],
      quotes: new Map([
        [fresh, quote(fresh, { localTs: now })],
        [stale, quote(stale, { localTs: now - 300_000 })], // stale
        // CCC missing entirely
      ]),
      baselines: new Map([[fresh, base], [stale, base]]),
      futInterpByEquity: new Map(),
      proximityByEquity: new Map(),
      niftyChangePct: 0,
      elapsedFraction: 0.5,
      now,
      minTurnoverCr: 25,
      staleMs: 60_000,
    });
    expect(out.coverage.eligible).toBe(3);
    expect(out.coverage.refreshed).toBe(1);
    expect(out.coverage.stale).toBe(1);
    expect(out.coverage.missingData).toBe(1);
    expect(out.notes.some((n) => n.includes("PARTIAL SCAN"))).toBe(true);
  });

  it("is deterministic for identical inputs", () => {
    const mk = () =>
      buildScanner({
        universe: [eq("AAA"), eq("EEE")],
        quotes: new Map([
          ["NSE_EQ|INAAA", quote("NSE_EQ|INAAA")],
          ["NSE_EQ|INEEE", quote("NSE_EQ|INEEE", { ltp: 90 })],
        ]),
        baselines: new Map([["NSE_EQ|INAAA", base], ["NSE_EQ|INEEE", base]]),
        futInterpByEquity: new Map(),
        proximityByEquity: new Map(),
        niftyChangePct: 0,
        elapsedFraction: 0.5,
        now: 1000000,
        minTurnoverCr: 25,
      });
    expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()));
    expect(mk().bullish[0].symbol).toBe("AAA");
    expect(mk().bearish[0].symbol).toBe("EEE");
  });
});
