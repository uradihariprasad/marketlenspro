/**
 * CVD momentum + bid/ask trade classification tests.
 *
 * Contracts under test:
 *  - quote rule (LTP vs contemporaneous bid/ask) is preferred; tick rule is
 *    the documented fallback; ambiguous increments stay UNKNOWN
 *  - a positive CVD alone NEVER produces a bullish state without price agreement
 *  - delta acceleration / consistency / normalised delta are computed correctly
 *  - session reset, duplicate and out-of-order updates are handled safely
 */
import { describe, it, expect } from "vitest";
import { FlowTracker, cvdMomentum } from "../src/lib/market/orderflow";

const DAY = "2026-10-27";
function ts(hhmm: string, date = DAY): number {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000 - 5.5 * 3_600_000;
}
const tot = (t: FlowTracker) => t.bars(5).reduce((a, b) => a + b.buyVol + b.sellVol + b.untracedVol, 0);

describe("bid/ask quote-rule classification", () => {
  it("a trade at the ASK is buyer-initiated even on a downtick", () => {
    const t = new FlowTracker();
    t.onQuote(100.0, 1000, ts("09:20"), { bid: 99.9, ask: 100.1 }); // baseline
    // price falls but prints at the ask → quote rule says BUY (tick rule would say SELL)
    t.onQuote(99.6, 1500, ts("09:21"), { bid: 99.4, ask: 99.6 });
    const bars = t.bars(5);
    expect(bars.reduce((a, b) => a + b.buyVol, 0)).toBe(500);
    expect(bars.reduce((a, b) => a + b.sellVol, 0)).toBe(0);
    expect(t.attribution().quoteRuleCount).toBe(1);
    expect(t.attribution().tickRuleCount).toBe(0);
  });

  it("a trade at the BID is seller-initiated even on an uptick", () => {
    const t = new FlowTracker();
    t.onQuote(100.0, 1000, ts("09:20"), { bid: 99.9, ask: 100.1 });
    t.onQuote(100.4, 1400, ts("09:21"), { bid: 100.4, ask: 100.6 }); // prints at bid
    const bars = t.bars(5);
    expect(bars.reduce((a, b) => a + b.sellVol, 0)).toBe(400);
    expect(bars.reduce((a, b) => a + b.buyVol, 0)).toBe(0);
    expect(t.attribution().quoteRuleCount).toBe(1);
  });

  it("mid-spread trades fall back to the documented tick rule", () => {
    const t = new FlowTracker();
    t.onQuote(99.5, 1000, ts("09:20"), { bid: 99.0, ask: 101.0 });
    // exactly mid-spread (neither near bid nor near ask) but an uptick
    t.onQuote(100.0, 1300, ts("09:21"), { bid: 99.0, ask: 101.0 });
    const a = t.attribution();
    expect(a.tickRuleCount).toBe(1);
    expect(a.quoteRuleCount).toBe(0);
    expect(t.bars(5).reduce((x, b) => x + b.buyVol, 0)).toBe(300);
  });

  it("the quote rule never classifies across the mid-point", () => {
    const t = new FlowTracker();
    t.onQuote(100.0, 1000, ts("09:20"), { bid: 99.0, ask: 101.0 });
    // just below the mid-point on an uptick: quote rule must not call it a BUY
    t.onQuote(99.9, 1300, ts("09:21"), { bid: 99.0, ask: 101.0 });
    expect(t.attribution().quoteRuleCount).toBe(0);
  });

  it("mid-spread with no prior price stays UNCLASSIFIED (never forced)", () => {
    const t = new FlowTracker();
    t.onQuote(100, 1000, ts("09:20"), { bid: 99, ask: 101 }); // baseline
    // volume reset re-baselines, clearing prevPrice context for attribution
    t.onQuote(100, 1500, ts("09:21"), { bid: 99, ask: 101 }); // unchanged, mid-spread
    const bars = t.bars(5);
    expect(bars.reduce((a, b) => a + b.untracedVol, 0)).toBe(500);
    expect(bars.reduce((a, b) => a + b.buyVol + b.sellVol, 0)).toBe(0);
    expect(t.attribution().unknownVol).toBe(500);
  });

  it("depth quantities are never used to create volume", () => {
    const t = new FlowTracker();
    // enormous quoted sizes but NO cumulative-volume change => zero traded volume
    t.onQuote(100, 5000, ts("09:20"), { bid: 99.9, ask: 100.1 });
    t.onQuote(100.1, 5000, ts("09:21"), { bid: 99.9, ask: 100.1 });
    expect(tot(t)).toBe(0);
  });
});

describe("delta metrics", () => {
  function buildBullish(): FlowTracker {
    const t = new FlowTracker();
    let vol = 1000;
    let price = 100;
    t.onQuote(price, vol, ts("09:20"), { bid: price - 0.05, ask: price + 0.05 });
    for (let i = 1; i <= 12; i++) {
      price += 0.5;
      vol += 1000;
      // print at the ask each time → unambiguous buyer-initiated
      t.onQuote(price, vol, ts(`09:${20 + i}`), { bid: price - 0.1, ask: price });
    }
    return t;
  }

  it("computes normalised delta, consistency and acceleration", () => {
    const t = buildBullish();
    const bars = t.bars(1);
    const closes = bars.map((_, i) => 100 + i);
    const m = cvdMomentum(bars, t.attribution(), closes, 8);
    expect(m.mode).toBe("ESTIMATED");
    expect(m.normalizedDelta).toBeCloseTo(100, 0); // all buy volume
    expect(m.deltaConsistency).toBe(1);
    expect(m.cvdSlope).not.toBeNull();
    expect(m.cvdSlope!).toBeGreaterThan(0);
    expect(m.deltaVsTotalVolume).toBeGreaterThan(0);
    expect(m.basis).toMatch(/ESTIMATED/);
    expect(m.basis).toMatch(/quote-rule/);
  });

  it("reports INSUFFICIENT_DATA rather than guessing with too few bars", () => {
    const t = new FlowTracker();
    t.onQuote(100, 1000, ts("09:20"), { bid: 99.9, ask: 100.1 });
    const m = cvdMomentum(t.bars(1), t.attribution(), [100], 8);
    expect(m.state).toBe("INSUFFICIENT_DATA");
    expect(m.mode).toBe("UNAVAILABLE");
    expect(m.pressure).toBe(0);
  });
});

describe("CVD momentum states", () => {
  function tracker(prices: number[], atAsk: boolean): FlowTracker {
    const t = new FlowTracker();
    let vol = 1000;
    t.onQuote(prices[0], vol, ts("09:20"), { bid: prices[0] - 0.1, ask: prices[0] + 0.1 });
    prices.slice(1).forEach((p, i) => {
      vol += 1000;
      const q = atAsk ? { bid: p - 0.1, ask: p } : { bid: p, ask: p + 0.1 };
      t.onQuote(p, vol, ts(`09:${21 + i}`), q);
    });
    return t;
  }

  it("rising price + buyer-initiated flow => bullish state", () => {
    const prices = Array.from({ length: 13 }, (_, i) => 100 + i * 0.5);
    const t = tracker(prices, true);
    const bars = t.bars(1);
    const m = cvdMomentum(bars, t.attribution(), prices.slice(-bars.length), 8);
    expect(["STRONG_BULLISH", "BULLISH"]).toContain(m.state);
    expect(m.priceAgrees).toBe(true);
    expect(m.pressure).toBeGreaterThan(0);
  });

  it("POSITIVE CVD with FALLING price is never bullish — it is weakening", () => {
    // every print at the ask (buy-classified) while price declines
    const prices = Array.from({ length: 13 }, (_, i) => 100 - i * 0.4);
    const t = tracker(prices, true);
    const bars = t.bars(1);
    const m = cvdMomentum(bars, t.attribution(), prices.slice(-bars.length), 8);
    expect(m.normalizedDelta).toBeGreaterThan(0); // CVD is positive...
    expect(m.priceAgrees).toBe(false);            // ...but price disagrees
    expect(m.state).toBe("WEAKENING_BULLISH");    // never BULLISH/STRONG_BULLISH
    expect(m.reasons.join(" ")).toMatch(/price has NOT confirmed/i);
  });

  it("falling price + seller-initiated flow => bearish state", () => {
    const prices = Array.from({ length: 13 }, (_, i) => 100 - i * 0.5);
    const t = tracker(prices, false); // prints at the bid
    const bars = t.bars(1);
    const m = cvdMomentum(bars, t.attribution(), prices.slice(-bars.length), 8);
    expect(["STRONG_BEARISH", "BEARISH"]).toContain(m.state);
    expect(m.normalizedDelta!).toBeLessThan(0);
  });

  it("low attribution coverage discounts the pressure", () => {
    const t = new FlowTracker();
    let vol = 1000;
    let price = 100;
    t.onQuote(price, vol, ts("09:20"), { bid: 99, ask: 101 });
    for (let i = 1; i <= 12; i++) {
      vol += 1000;
      // alternate: half classified at ask, half unchanged mid-spread (UNKNOWN)
      if (i % 2 === 0) {
        price += 0.5;
        t.onQuote(price, vol, ts(`09:${20 + i}`), { bid: price - 0.1, ask: price });
      } else {
        t.onQuote(price, vol, ts(`09:${20 + i}`), { bid: price - 1, ask: price + 1 });
      }
    }
    const a = t.attribution();
    expect(a.unknownVol).toBeGreaterThan(0);
    expect(a.coveragePct).toBeLessThan(100);
    const bars = t.bars(1);
    const m = cvdMomentum(bars, a, bars.map((_, i) => 100 + i), 8);
    expect(m.reasons.join(" ")).toMatch(/could be attributed|discounted/i);
  });
});

describe("session, duplicate and ordering safety", () => {
  it("resets CVD at the session boundary and re-baselines", () => {
    const t = new FlowTracker();
    t.onQuote(100, 1000, ts("09:20", "2026-10-26"), { bid: 99.9, ask: 100 });
    t.onQuote(101, 2000, ts("09:21", "2026-10-26"), { bid: 100.9, ask: 101 });
    expect(t.bars(5).at(-1)!.cvd).toBe(1000);
    t.onQuote(100, 90_000, ts("09:20", "2026-10-27"), { bid: 99.9, ask: 100 });
    expect(t.bars(5)).toHaveLength(0); // new session: baseline only
    expect(t.attribution().baselineVol).toBe(90_000);
  });

  it("a duplicate update with identical cumulative volume adds nothing", () => {
    const t = new FlowTracker();
    t.onQuote(100, 1000, ts("09:20"), { bid: 99.9, ask: 100.1 });
    t.onQuote(101, 2000, ts("09:21"), { bid: 100.9, ask: 101 });
    const before = tot(t);
    t.onQuote(101, 2000, ts("09:21"), { bid: 100.9, ask: 101 }); // duplicate poll
    expect(tot(t)).toBe(before);
  });

  it("an out-of-order/backwards volume update re-baselines instead of going negative", () => {
    const t = new FlowTracker();
    t.onQuote(100, 5000, ts("09:20"), { bid: 99.9, ask: 100.1 });
    t.onQuote(101, 6000, ts("09:21"), { bid: 100.9, ask: 101 });
    t.onQuote(100, 500, ts("09:22"), { bid: 99.9, ask: 100.1 }); // backwards
    expect(t.attribution().resets).toBe(1);
    for (const b of t.bars(5)) {
      expect(b.buyVol).toBeGreaterThanOrEqual(0);
      expect(b.sellVol).toBeGreaterThanOrEqual(0);
    }
  });

  it("zero-volume periods produce no fabricated delta", () => {
    const t = new FlowTracker();
    t.onQuote(100, 1000, ts("09:20"), { bid: 99.9, ask: 100.1 });
    for (let i = 1; i <= 5; i++) t.onQuote(100 + i * 0.1, 1000, ts(`09:${20 + i}`), { bid: 99.9, ask: 100.1 });
    expect(tot(t)).toBe(0);
    const m = cvdMomentum(t.bars(1), t.attribution(), [100, 101], 8);
    expect(["INSUFFICIENT_DATA", "NEUTRAL"]).toContain(m.state);
  });
});
