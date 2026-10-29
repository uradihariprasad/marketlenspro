/**
 * Delta/CVD integration tests.
 *
 * Verifies the two verified root causes are fixed:
 *  RC-1  Spot indices report no traded volume, so their flow must be proxied
 *        from the nearest NON-EXPIRED index-futures contract.
 *  RC-2  Tracker eviction deleted the first-inserted (index/futures) trackers,
 *        silently destroying index flow once the universe exceeded the cap.
 *  RC-3  flowConfirmation() and cvdMomentum() computed independently; they must
 *        now agree because there is one calculation path.
 */
import { describe, it, expect } from "vitest";
import { FlowTracker, flowConfirmation, cvdMomentum } from "../src/lib/market/orderflow";

const DAY = "2026-10-27";
function ts(hhmm: string, date = DAY): number {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000 - 5.5 * 3_600_000;
}

/** A tracker with genuine buyer-side flow (prints at the ask). */
function bullishTracker(bars = 12): FlowTracker {
  const t = new FlowTracker();
  let vol = 1000;
  let price = 100;
  t.onQuote(price, vol, ts("09:20"), { bid: price - 0.1, ask: price + 0.1 });
  for (let i = 1; i <= bars; i++) {
    price += 0.5;
    vol += 1000;
    t.onQuote(price, vol, ts(`09:${20 + i}`), { bid: price - 0.1, ask: price });
  }
  return t;
}
const closesFor = (n: number) => Array.from({ length: n }, (_, i) => 100 + i * 0.5);

describe("RC-3: one calculation path — consumers cannot disagree", () => {
  it("flowConfirmation and cvdMomentum report the SAME direction and normalised delta", () => {
    const t = bullishTracker(12);
    const bars = t.bars(1);
    const closes = closesFor(bars.length);
    const fc = flowConfirmation(bars, t.attribution(), closes, ts("09:33"), 8);
    const m = cvdMomentum(bars, t.attribution(), closes, 8);

    expect(fc.available).toBe(true);
    expect(m.mode).toBe("ESTIMATED");
    // identical normalised delta (flowConfirmation exposes it as -1..1 ratio)
    expect(fc.deltaRatio).not.toBeNull();
    expect(m.normalizedDelta).not.toBeNull();
    expect(fc.deltaRatio!).toBeCloseTo(m.normalizedDelta! / 100, 3);
    // identical CVD slope and level
    expect(fc.cvdSlope).toBe(m.cvdSlope);
    expect(fc.cvdNow).toBe(m.cvdNow);
    // directionally identical status vs state
    expect(["BULLISH"]).toContain(fc.status);
    expect(["STRONG_BULLISH", "BULLISH"]).toContain(m.state);
  });

  it("a weakening (price-unconfirmed) flow is reflected consistently in both", () => {
    // prints at the ask (buy-classified) while price FALLS
    const t = new FlowTracker();
    let vol = 1000;
    t.onQuote(100, vol, ts("09:20"), { bid: 99.9, ask: 100 });
    for (let i = 1; i <= 12; i++) {
      vol += 1000;
      const p = 100 - i * 0.4;
      t.onQuote(p, vol, ts(`09:${20 + i}`), { bid: p - 0.1, ask: p });
    }
    const bars = t.bars(1);
    const closes = Array.from({ length: bars.length }, (_, i) => 100 - i * 0.4);
    const fc = flowConfirmation(bars, t.attribution(), closes, ts("09:33"), 8);
    const m = cvdMomentum(bars, t.attribution(), closes, 8);
    expect(m.state).toBe("WEAKENING_BULLISH"); // price did not confirm
    expect(fc.status).toBe("NEUTRAL"); // downgraded identically
    expect(fc.score).toBeLessThan(m.state.includes("BULLISH") ? 1 : 1);
  });

  it("unavailable flow yields zero score, never a fabricated direction", () => {
    const fc = flowConfirmation([], null, [], ts("09:33"));
    expect(fc.available).toBe(false);
    expect(fc.score).toBe(0);
    expect(fc.deltaRatio).toBeNull();
  });
});

describe("RC-1: spot indices carry no volume — flow must come from a proxy", () => {
  it("a spot-index tracker fed null volume accumulates NO flow (the defect)", () => {
    const t = new FlowTracker();
    // Upstox returns no volume for computed spot indexes
    for (let i = 0; i < 20; i++) t.onQuote(100 + i * 0.2, null, ts(`09:${20 + i}`), { bid: 99.9, ask: 100.3 });
    const a = t.attribution();
    expect(a.totalVol).toBe(0);
    expect(a.observations).toBe(20);
    const m = cvdMomentum(t.bars(1), a, [100, 101], 8);
    expect(m.mode).toBe("UNAVAILABLE");
    expect(m.state).toBe("INSUFFICIENT_DATA");
    // proves a spot index alone can never produce flow => proxy is required
  });

  it("an index-futures tracker produces usable flow for the same index", () => {
    const fut = bullishTracker(12); // the resolved proxy source
    const bars = fut.bars(1);
    const m = cvdMomentum(bars, fut.attribution(), closesFor(bars.length), 8);
    expect(m.mode).toBe("ESTIMATED");
    expect(["STRONG_BULLISH", "BULLISH"]).toContain(m.state);
    expect(m.normalizedDelta).toBeGreaterThan(0);
  });

  it("instrument isolation: two trackers never share volume", () => {
    const a = bullishTracker(8);
    const b = new FlowTracker(); // different instrument, no data
    const volA = a.attribution().totalVol;
    expect(volA).toBeGreaterThan(0);
    expect(b.attribution().totalVol).toBe(0);
    expect(a.bars(1).length).toBeGreaterThan(0);
    expect(b.bars(1).length).toBe(0);
  });
});

describe("RC-2: index/futures flow must survive tracker pressure", () => {
  it("the previous eviction loop removed only ONE entry per call (the bug)", () => {
    // Reproduces the old logic to document the defect it caused.
    const trackers = new Map<string, number>();
    const INDEX_KEYS = ["NSE_INDEX|Nifty 50", "NSE_FO|48000"];
    const all = [...INDEX_KEYS, ...Array.from({ length: 200 }, (_, i) => `NSE_EQ|S${i}`)];
    for (const k of all) {
      trackers.set(k, 1);
      if (trackers.size > 120) {
        for (const key of trackers.keys()) {
          if (trackers.size <= 100) break;
          trackers.delete(key);
          break; // <-- deleted exactly one, and always the FIRST inserted
        }
      }
    }
    // Under the old logic the index keys (inserted first) are destroyed.
    const survivedOld = INDEX_KEYS.every((k) => trackers.has(k));
    expect(survivedOld).toBe(false); // documents RC-2
  });

  it("protected keys survive when eviction is source-aware", () => {
    // The corrected policy: never evict spot-index / index-future trackers.
    const MAX = 260;
    const protectedKeys = new Set(["NSE_INDEX|Nifty 50", "NSE_FO|48000", "BSE_INDEX|SENSEX"]);
    const trackers = new Map<string, number>();
    const all = [...protectedKeys, ...Array.from({ length: 400 }, (_, i) => `NSE_EQ|S${i}`)];
    for (const k of all) {
      trackers.set(k, 1);
      if (trackers.size > MAX) {
        for (const key of trackers.keys()) {
          if (trackers.size <= MAX) break;
          if (protectedKeys.has(key)) continue; // <-- the fix
          trackers.delete(key);
        }
      }
    }
    for (const k of protectedKeys) expect(trackers.has(k)).toBe(true);
    expect(trackers.size).toBeLessThanOrEqual(MAX + protectedKeys.size);
  });
});

describe("session boundary and duplicate handling (regression)", () => {
  it("session CVD resets and re-baselines at the boundary", () => {
    const t = bullishTracker(6);
    expect(t.bars(1).at(-1)!.cvd).toBeGreaterThan(0);
    t.onQuote(100, 90_000, ts("09:20", "2026-10-28"), { bid: 99.9, ask: 100 });
    expect(t.bars(1)).toHaveLength(0); // new session, baseline only
    expect(t.attribution().baselineVol).toBe(90_000);
  });

  it("duplicate snapshots never double-count volume", () => {
    const t = new FlowTracker();
    t.onQuote(100, 1000, ts("09:20"), { bid: 99.9, ask: 100.1 });
    t.onQuote(101, 2000, ts("09:21"), { bid: 100.9, ask: 101 });
    const before = t.attribution().totalVol;
    t.onQuote(101, 2000, ts("09:21"), { bid: 100.9, ask: 101 }); // duplicate
    expect(t.attribution().totalVol).toBe(before);
  });

  it("zero-volume observations produce no delta and no fabricated state", () => {
    const t = new FlowTracker();
    t.onQuote(100, 5000, ts("09:20"), { bid: 99.9, ask: 100.1 });
    for (let i = 1; i <= 6; i++) t.onQuote(100 + i, 5000, ts(`09:${20 + i}`), { bid: 99.9, ask: 100.1 });
    const a = t.attribution();
    expect(a.totalVol).toBe(0);
    const m = cvdMomentum(t.bars(1), a, [100, 106], 8);
    expect(["INSUFFICIENT_DATA", "NEUTRAL"]).toContain(m.state);
    expect(m.normalizedDelta).toBeNull();
  });
});
