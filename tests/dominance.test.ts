/**
 * Buyer/Seller Dominance engine tests.
 *
 * Core contracts under test:
 *  - dominance ≠ trade entry (poor entry location ⇒ WATCHLIST_ONLY)
 *  - raw Delta is never compared across instruments (normalised ratio only)
 *  - the list is never padded to N
 *  - missing evidence scores 0, never a penalty and never an assumption
 */
import { describe, it, expect } from "vitest";
import { buildDominance, DominanceStructure } from "../src/lib/market/dominance";
import type { ScannerRow, FlowConfirmView } from "../src/lib/market/scanner";
import { Zone } from "../src/lib/market/types";

function zone(mid: number, side: Zone["side"], state: Zone["state"] = "CONFIRMED"): Zone {
  return {
    id: `z${mid}`, instrumentKey: "T|X", timeframeMin: 5, side,
    lower: mid - 1, upper: mid + 1, mid,
    provenanceGroup: "STRUCTURAL", confirmationStatus: "CONFIRMED",
    state, score: 3, breakdown: [], sources: [], touches: [],
    invalidation: mid, createdAt: 0, updatedAt: 0,
  };
}

function flow(over: Partial<FlowConfirmView> = {}): FlowConfirmView {
  return {
    status: "BULLISH", available: true, reason: "test",
    deltaRatio: 0.8, cvdSlope: 500, attributionPct: 80, score: 0.8,
    label: "ESTIMATED flow bullish", ...over,
  };
}

function row(over: Partial<ScannerRow> = {}): ScannerRow {
  return {
    instrumentKey: "NSE_EQ|INAAA", symbol: "AAA", ltp: 100, changePct: 3,
    momentum: { classification: "CONFIRMED_BULLISH", direction: 1, strength: 0.9, participation: 0.8, atrMove: 1.4, breakdown: [] },
    flow: flow(),
    volumeCum: 5_000_000, turnoverCr: 500, rvol: 3, rvolMode: "APPROXIMATE",
    atrPct: 2, rsVsNifty: 1.5, vwapPos: "ABOVE", futInterp: null, proximity: null,
    score: 5, reasons: [], exclusions: [], quality: "LIVE",
    ...over,
  };
}

function structure(over: Partial<DominanceStructure> = {}): DominanceStructure {
  return {
    trend: "UP", lastEvent: "BOS_UP @ 99", zones: [],
    primarySupport: zone(96, "SUPPORT"), primaryResistance: zone(106, "RESISTANCE"),
    atr: 2, analysedAt: Date.now(), ...over,
  };
}

const now = Date.now();

describe("dominance ranking", () => {
  it("ranks a genuinely bought stock as a top buyer with an actionable setup", () => {
    const out = buildDominance({
      rows: [row()],
      structures: new Map([["NSE_EQ|INAAA", structure()]]),
      now, topN: 5,
    });
    expect(out.buyers).toHaveLength(1);
    const c = out.buyers[0];
    expect(c.side).toBe("BUYER");
    expect(c.rank).toBe(1);
    expect(c.score).toBeGreaterThan(60);
    expect(c.action).toBe("ACTIONABLE");
    expect(c.why.length).toBeGreaterThan(0);
    // score is fully explained by the factor breakdown
    expect(c.factors.length).toBeGreaterThanOrEqual(6);
  });

  it("a seller-side stock never appears on the buyer board", () => {
    const bear = row({
      symbol: "BBB", instrumentKey: "NSE_EQ|INBBB", changePct: -3,
      momentum: { classification: "CONFIRMED_BEARISH", direction: -1, strength: 0.9, participation: 0.8, atrMove: -1.4, breakdown: [] },
      flow: flow({ status: "BEARISH", deltaRatio: -0.8, cvdSlope: -500, score: -0.8 }),
      rsVsNifty: -1.5, vwapPos: "BELOW",
    });
    const out = buildDominance({
      rows: [bear],
      structures: new Map([["NSE_EQ|INBBB", structure({ trend: "DOWN" })]]),
      now, topN: 5,
    });
    expect(out.buyers).toHaveLength(0);
    expect(out.sellers).toHaveLength(1);
    expect(out.sellers[0].side).toBe("SELLER");
  });
});

describe("dominance is NOT a trade entry", () => {
  it("strong buying pressing straight into resistance => WATCHLIST_ONLY", () => {
    const out = buildDominance({
      rows: [row()],
      // resistance only 0.5 away with ATR 2 => 0.25 ATR of room
      structures: new Map([["NSE_EQ|INAAA", structure({ primaryResistance: zone(100.5, "RESISTANCE") })]]),
      now, topN: 5,
    });
    const c = out.buyers[0];
    expect(c.entryLocation).toBe("INTO_OPPOSING_ZONE");
    expect(c.action).toBe("WATCHLIST_ONLY");
    expect(c.actionReason).toMatch(/poor entry location/i);
    expect(c.reversalRisk.level).not.toBe("LOW");
  });

  it("an over-extended move is watchlist only, not actionable", () => {
    const out = buildDominance({
      rows: [row()],
      // resistance 20 away with ATR 2 => 10 ATR of room
      structures: new Map([["NSE_EQ|INAAA", structure({ primaryResistance: zone(120, "RESISTANCE") })]]),
      now, topN: 5,
    });
    expect(out.buyers[0].entryLocation).toBe("EXTENDED");
    expect(out.buyers[0].action).toBe("WATCHLIST_ONLY");
  });

  it("without order-flow confirmation the candidate NEEDS_CONFIRMATION", () => {
    const out = buildDominance({
      rows: [row({ flow: { status: "UNAVAILABLE", available: false, reason: "no observations", deltaRatio: null, cvdSlope: null, attributionPct: 0, score: 0, label: "flow unavailable" } })],
      structures: new Map([["NSE_EQ|INAAA", structure()]]),
      now, topN: 5,
    });
    const c = out.buyers[0];
    expect(c.action).toBe("NEEDS_CONFIRMATION");
    expect(c.flowMode).toBe("UNAVAILABLE");
    // missing flow contributes exactly zero — never a penalty
    const flowFactors = c.factors.filter((f) => f.k.includes("delta") || f.k.includes("CVD"));
    for (const f of flowFactors) expect(f.v).toBe(0);
  });

  it("no zone ahead of price => cannot frame a target, NEEDS_CONFIRMATION", () => {
    const out = buildDominance({
      rows: [row()],
      structures: new Map([["NSE_EQ|INAAA", structure({ primaryResistance: null })]]),
      now, topN: 5,
    });
    expect(out.buyers[0].entryLocation).toBe("UNKNOWN");
    expect(out.buyers[0].action).toBe("NEEDS_CONFIRMATION");
    expect(out.buyers[0].nextTarget).toBeNull();
  });
});

describe("normalisation and fairness across instruments", () => {
  it("uses the normalised delta ratio, so a huge-volume stock cannot dominate on raw delta", () => {
    const small = row({ symbol: "SMALL", instrumentKey: "NSE_EQ|INSMALL", volumeCum: 100_000, turnoverCr: 60, flow: flow({ deltaRatio: 0.9, attributionPct: 80 }) });
    const huge = row({ symbol: "HUGE", instrumentKey: "NSE_EQ|INHUGE", volumeCum: 900_000_000, turnoverCr: 9000, flow: flow({ deltaRatio: 0.2, attributionPct: 80 }) });
    const out = buildDominance({
      rows: [small, huge],
      structures: new Map([
        ["NSE_EQ|INSMALL", structure()],
        ["NSE_EQ|INHUGE", structure()],
      ]),
      now, topN: 5,
    });
    // the stock with the better NORMALISED delta ranks higher despite far
    // lower absolute volume
    expect(out.buyers[0].symbol).toBe("SMALL");
  });

  it("low attribution coverage earns proportionally less flow credit", () => {
    const good = row({ symbol: "GOODATTR", instrumentKey: "NSE_EQ|INGOOD", flow: flow({ attributionPct: 90 }) });
    const thin = row({ symbol: "THINATTR", instrumentKey: "NSE_EQ|INTHIN", flow: flow({ attributionPct: 25 }) });
    const out = buildDominance({
      rows: [good, thin],
      structures: new Map([["NSE_EQ|INGOOD", structure()], ["NSE_EQ|INTHIN", structure()]]),
      now, topN: 5,
    });
    const g = out.buyers.find((c) => c.symbol === "GOODATTR")!;
    const t = out.buyers.find((c) => c.symbol === "THINATTR")!;
    expect(g.score).toBeGreaterThan(t.score);
  });
});

describe("no padding, no fabrication", () => {
  it("returns fewer than N and explains the empty slots", () => {
    const out = buildDominance({
      rows: [row()],
      structures: new Map([["NSE_EQ|INAAA", structure()]]),
      now, topN: 5,
    });
    expect(out.buyers.length).toBe(1);
    expect(out.sellers.length).toBe(0);
    expect(out.shortfallNote).toBeTruthy();
    expect(out.shortfallNote).toMatch(/slot\(s\) empty/);
    expect(out.shortfallNote).toMatch(/never padded/i);
  });

  it("a flat high-volume stock produces no dominance on either side", () => {
    const flat = row({
      symbol: "FLAT", instrumentKey: "NSE_EQ|INFLAT", changePct: 0,
      momentum: { classification: "NO_MOMENTUM", direction: 0, strength: 0, participation: 0.9, atrMove: 0, breakdown: [] },
      flow: { status: "NEUTRAL", available: true, reason: "flat", deltaRatio: 0, cvdSlope: 0, attributionPct: 80, score: 0, label: "neutral" },
      rsVsNifty: 0, vwapPos: null,
    });
    const out = buildDominance({
      rows: [flat],
      structures: new Map([["NSE_EQ|INFLAT", structure({ trend: "NEUTRAL" })]]),
      now, topN: 5,
    });
    expect(out.buyers).toHaveLength(0);
    expect(out.sellers).toHaveLength(0);
  });

  it("illiquid instruments stay RANKED but can never be ACTIONABLE", () => {
    // New contract: a hard turnover cutoff must not delete genuine evidence
    // from the leaderboard; it only blocks trade qualification.
    const illiquid = row({ symbol: "TINY", instrumentKey: "NSE_EQ|INTINY", turnoverCr: 3, liquidityTier: "INSUFFICIENT" });
    const out = buildDominance({
      rows: [illiquid],
      structures: new Map([["NSE_EQ|INTINY", structure()]]),
      now, topN: 5, minTurnoverCr: 25,
    });
    expect(out.buyers).toHaveLength(1); // visible
    const c = out.buyers[0];
    expect(c.action).not.toBe("ACTIONABLE"); // but never tradable
    expect(c.liquidityTier).toBe("INSUFFICIENT");
    expect(c.actionReason).toMatch(/liquidity/i);
  });

  it("scores are bounded 0..100 and deterministic", () => {
    const args = { rows: [row()], structures: new Map([["NSE_EQ|INAAA", structure()]]), now, topN: 5 };
    const a = buildDominance(args);
    const b = buildDominance(args);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const c of [...a.buyers, ...a.sellers]) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
    }
  });

  it("reports honest coverage counters", () => {
    const out = buildDominance({
      rows: [row(), row({ symbol: "STALE2", instrumentKey: "NSE_EQ|INSTALE2", quality: "STALE" })],
      structures: new Map([["NSE_EQ|INAAA", structure()]]),
      now, topN: 5,
    });
    expect(out.coverage.universe).toBe(2);
    expect(out.coverage.stale).toBe(1);
    expect(out.coverage.withStructure).toBe(1);
    expect(out.evaluated).toBe(2);
  });
});

describe("reversal risk", () => {
  it("flags HIGH risk when flow opposes the dominance direction at a zone", () => {
    const out = buildDominance({
      rows: [row({ flow: flow({ status: "BEARISH", deltaRatio: -0.6, cvdSlope: -300, score: -0.6 }) })],
      structures: new Map([["NSE_EQ|INAAA", structure({ trend: "DOWN", primaryResistance: zone(100.5, "RESISTANCE") })]]),
      now, topN: 5,
    });
    const c = out.buyers[0];
    if (c) {
      expect(c.reversalRisk.level).toBe("HIGH");
      expect(c.reversalRisk.reasons.join(" ")).toMatch(/absorption|opposes/i);
      expect(c.action).not.toBe("ACTIONABLE");
    }
  });
});
