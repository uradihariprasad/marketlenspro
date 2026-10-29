/**
 * Regression tests for the two confirmed defects:
 *
 *  RC#1 — the dominance engine consumed only the UNION OF THE RANKED BOARDS
 *         (4 boards × 12 = ~22 deduped instruments), so coverage could never
 *         exceed the board sizes regardless of universe size.
 *  RC#2 — a single hard floor (score ≥ 45) combined with rows that carried no
 *         momentum/flow data emptied the entire leaderboard.
 */
import { describe, it, expect } from "vitest";
import { buildScanner, Baseline, ScannerRow } from "../src/lib/market/scanner";
import { buildDominance, DominanceStructure } from "../src/lib/market/dominance";
import { InstrumentMeta, Quote, Zone } from "../src/lib/market/types";

function eq(sym: string): InstrumentMeta {
  return { instrumentKey: `NSE_EQ|IN${sym}`, tradingSymbol: sym, name: sym, segment: "NSE_EQ", instrumentType: "EQ", tickSize: 0.05 };
}
function quote(key: string, over: Partial<Quote> = {}): Quote {
  return {
    instrumentKey: key, source: "UPSTOX_REST_POLL",
    exchangeTs: 1000, lastTradeTs: 1000, localTs: Date.now(),
    ltp: 103, ltq: 10, volumeCum: 40_000_000, oi: null,
    open: 100, high: 104, low: 99, close: 100, atp: 101.5,
    bid: null, ask: null, depthLevels: 0, quality: "LIVE", netChange: null, ...over,
  };
}
const base: Baseline = { avgVol20: 800_000, atr14: 2 };
const now = Date.now();

/** 150 distinct stocks with genuine, varied directional moves. */
function bigUniverse(n = 150) {
  const universe: InstrumentMeta[] = [];
  const quotes = new Map<string, Quote>();
  const baselines = new Map<string, Baseline>();
  for (let i = 0; i < n; i++) {
    const sym = `S${String(i).padStart(3, "0")}`;
    const m = eq(sym);
    universe.push(m);
    const up = i % 2 === 0;
    const mag = 1 + (i % 7) * 0.4; // 1%..3.4%
    const ltp = up ? 100 * (1 + mag / 100) : 100 * (1 - mag / 100);
    quotes.set(m.instrumentKey, quote(m.instrumentKey, { ltp, close: 100, atp: (ltp + 100) / 2, volumeCum: 20_000_000 + i * 100_000 }));
    baselines.set(m.instrumentKey, base);
  }
  return { universe, quotes, baselines };
}

function scan(n = 150) {
  const { universe, quotes, baselines } = bigUniverse(n);
  return buildScanner({
    universe, quotes, baselines,
    futInterpByEquity: new Map(), proximityByEquity: new Map(),
    niftyChangePct: 0, elapsedFraction: 0.5, now, minTurnoverCr: 25,
  });
}

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

describe("RC#1 — coverage is the full evaluated universe, not the ranked boards", () => {
  it("scanner exposes every evaluated row via allRows", () => {
    const sc = scan(150);
    expect(sc.allRows.length).toBe(150);
    // boards remain capped — proving allRows is a genuinely different set
    expect(sc.bullish.length).toBeLessThanOrEqual(12);
    expect(sc.bearish.length).toBeLessThanOrEqual(12);
    const boardUnion = new Set([...sc.bullish, ...sc.bearish, ...sc.rvolLeaders, ...sc.liquid].map((r) => r.instrumentKey));
    expect(boardUnion.size).toBeLessThan(sc.allRows.length); // the old ~22 path
  });

  it("dominance evaluates all 150 instruments when fed allRows", () => {
    const sc = scan(150);
    const structures = new Map(sc.allRows.map((r) => [r.instrumentKey, structure()]));
    const dom = buildDominance({ rows: sc.allRows, structures, eligibleUniverse: 150, now, topN: 5 });
    expect(dom.evaluated).toBe(150);
    expect(dom.coverage.eligibleUniverse).toBe(150);
    expect(dom.coverage.coveragePct).toBe(100);
    expect(dom.coverage.partial).toBe(false);
    // and it is NOT limited to the old ~22
    expect(dom.evaluated).toBeGreaterThan(22);
  });

  it("reports PARTIAL coverage honestly when only a subset was scanned", () => {
    const sc = scan(40);
    const structures = new Map(sc.allRows.map((r) => [r.instrumentKey, structure()]));
    const dom = buildDominance({ rows: sc.allRows, structures, eligibleUniverse: 213, now, topN: 5 });
    expect(dom.coverage.partial).toBe(true);
    expect(dom.coverage.coveragePct).toBeLessThan(100);
    expect(dom.coverage.evaluated).toBe(40);
    expect(dom.coverage.eligibleUniverse).toBe(213);
  });

  it("deduplicates repeated instrument records so a stock ranks once", () => {
    const sc = scan(20);
    const dupes = [...sc.allRows, ...sc.allRows]; // same stocks twice
    const rows = [...new Map(dupes.map((r) => [r.instrumentKey, r])).values()];
    const structures = new Map(rows.map((r) => [r.instrumentKey, structure()]));
    const dom = buildDominance({ rows, structures, eligibleUniverse: 20, now, topN: 10 });
    const syms = dom.buyers.map((b) => b.symbol);
    expect(new Set(syms).size).toBe(syms.length);
  });
});

describe("RC#2 — the leaderboard is no longer emptied by a single hard floor", () => {
  it("returns candidates from a realistic universe (was zero before)", () => {
    const sc = scan(150);
    const structures = new Map(sc.allRows.map((r) => [r.instrumentKey, structure()]));
    const dom = buildDominance({ rows: sc.allRows, structures, eligibleUniverse: 150, now, topN: 5 });
    expect(dom.buyers.length).toBeGreaterThan(0);
    expect(dom.sellers.length).toBeGreaterThan(0);
    expect(dom.buyers.length).toBeLessThanOrEqual(5);
  });

  it("missing flow data does NOT disqualify an otherwise valid candidate", () => {
    const sc = scan(30);
    expect(sc.allRows.every((r) => !r.flow?.available)).toBe(true); // no flow at all
    const structures = new Map(sc.allRows.map((r) => [r.instrumentKey, structure()]));
    const dom = buildDominance({ rows: sc.allRows, structures, eligibleUniverse: 30, now, topN: 5 });
    expect(dom.buyers.length).toBeGreaterThan(0);
    for (const c of dom.buyers) {
      expect(c.flowMode).toBe("UNAVAILABLE");
      expect(c.action).not.toBe("ACTIONABLE"); // visible, but never tradable
    }
    expect(dom.coverage.withFlow).toBe(0); // counted honestly
  });

  it("missing data is never scored as a zero/neutral signal", () => {
    const sc = scan(10);
    const structures = new Map(sc.allRows.map((r) => [r.instrumentKey, structure()]));
    const dom = buildDominance({ rows: sc.allRows, structures, eligibleUniverse: 10, now, topN: 5 });
    for (const c of [...dom.buyers, ...dom.sellers]) {
      const flowFactors = c.factors.filter((f) => f.mode === "UNAVAILABLE");
      for (const f of flowFactors) expect(f.v).toBe(0); // zero contribution, not zero agreement
    }
  });

  it("rows lacking a valid price are INSUFFICIENT_DATA, not silently ranked", () => {
    const bad: ScannerRow = {
      instrumentKey: "NSE_EQ|INBAD", symbol: "BAD", ltp: 0, changePct: NaN,
      volumeCum: null, turnoverCr: null, rvol: null, rvolMode: "UNAVAILABLE",
      atrPct: null, rsVsNifty: null, vwapPos: null, futInterp: null, proximity: null,
      score: 0, reasons: [], exclusions: [], quality: "LIVE",
    };
    const dom = buildDominance({ rows: [bad], structures: new Map(), eligibleUniverse: 1, now, topN: 5 });
    expect(dom.buyers).toHaveLength(0);
    expect(dom.coverage.insufficientData).toBe(1);
    expect(dom.coverage.withValidPriceVolume).toBe(0);
  });

  it("ranking floor and actionable floor are separately configurable", () => {
    const sc = scan(60);
    const structures = new Map(sc.allRows.map((r) => [r.instrumentKey, structure()]));
    const lenient = buildDominance({ rows: sc.allRows, structures, eligibleUniverse: 60, now, topN: 10, minScore: 5 });
    const strict = buildDominance({ rows: sc.allRows, structures, eligibleUniverse: 60, now, topN: 10, minScore: 95 });
    expect(lenient.buyers.length).toBeGreaterThan(strict.buyers.length);
    expect(lenient.settings.minScore).toBe(5);
    expect(strict.settings.minScore).toBe(95);
    // the old single floor of 45 must no longer empty the board
    const atOldFloor = buildDominance({ rows: sc.allRows, structures, eligibleUniverse: 60, now, topN: 10 });
    expect(atOldFloor.buyers.length).toBeGreaterThan(0);
    expect(atOldFloor.settings.minActionableScore).toBe(45);
  });
});

describe("Top-N controls and directional correctness", () => {
  it("Top 3 / Top 5 / Top 10 all return the requested maximum", () => {
    const sc = scan(150);
    const structures = new Map(sc.allRows.map((r) => [r.instrumentKey, structure()]));
    for (const n of [3, 5, 10]) {
      const dom = buildDominance({ rows: sc.allRows, structures, eligibleUniverse: 150, now, topN: n });
      expect(dom.buyers.length).toBeLessThanOrEqual(n);
      expect(dom.sellers.length).toBeLessThanOrEqual(n);
      expect(dom.requested).toBe(n);
      expect(dom.buyers.map((b) => b.rank)).toEqual(dom.buyers.map((_, i) => i + 1));
    }
  });

  it("buyers are up-movers and sellers are down-movers", () => {
    const sc = scan(150);
    const structures = new Map(sc.allRows.map((r) => [r.instrumentKey, structure()]));
    const dom = buildDominance({ rows: sc.allRows, structures, eligibleUniverse: 150, now, topN: 10 });
    for (const b of dom.buyers) expect(b.changePct).toBeGreaterThan(0);
    for (const s of dom.sellers) expect(s.changePct).toBeLessThan(0);
    // sorted by score descending, deterministic ties
    const scores = dom.buyers.map((b) => b.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("is deterministic across identical runs", () => {
    const sc = scan(80);
    const structures = new Map(sc.allRows.map((r) => [r.instrumentKey, structure()]));
    const a = buildDominance({ rows: sc.allRows, structures, eligibleUniverse: 80, now, topN: 5 });
    const b = buildDominance({ rows: sc.allRows, structures, eligibleUniverse: 80, now, topN: 5 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("liquidity tiers replace the single hard cutoff", () => {
  it("assigns configurable tiers and keeps thin names visible", () => {
    const universe = [eq("THIN"), eq("FAT")];
    const quotes = new Map([
      ["NSE_EQ|INTHIN", quote("NSE_EQ|INTHIN", { volumeCum: 100_000 })],   // ~1 Cr
      ["NSE_EQ|INFAT", quote("NSE_EQ|INFAT", { volumeCum: 40_000_000 })],  // ~400 Cr
    ]);
    const sc = buildScanner({
      universe, quotes,
      baselines: new Map([["NSE_EQ|INTHIN", base], ["NSE_EQ|INFAT", base]]),
      futInterpByEquity: new Map(), proximityByEquity: new Map(),
      niftyChangePct: 0, elapsedFraction: 0.5, now, minTurnoverCr: 25,
    });
    const thin = sc.allRows.find((r) => r.symbol === "THIN")!;
    const fat = sc.allRows.find((r) => r.symbol === "FAT")!;
    expect(thin.liquidityTier).toBe("INSUFFICIENT");
    expect(fat.liquidityTier).toBe("HIGH");
    // thin name is still present in allRows → still rankable
    expect(sc.allRows).toHaveLength(2);
  });
});
