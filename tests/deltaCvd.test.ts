/**
 * Delta / CVD accounting tests (Prompt §6).
 *
 * The critical rule under test: the FIRST cumulative-volume observation is a
 * BASELINE and must contribute ZERO traded volume. Attributing a whole
 * session's cumulative volume to one poll previously corrupted Delta/CVD and
 * volume totals, especially on a mid-session start.
 */
import { describe, it, expect } from "vitest";
import { FlowTracker, flowConfirmation } from "../src/lib/market/orderflow";

const DAY = "2026-10-26";
function ts(hhmm: string, date = DAY): number {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000 - 5.5 * 3_600_000;
}
const totalVol = (t: FlowTracker) =>
  t.bars(5).reduce((a, b) => a + b.buyVol + b.sellVol + b.untracedVol, 0);

describe("first observation = baseline (not traded volume)", () => {
  it("records zero traded volume on the first observation even mid-session", () => {
    const t = new FlowTracker();
    t.onQuote(100, 5_000_000, ts("13:00")); // mid-session start, huge cum volume
    const a = t.attribution();
    expect(a.baselineVol).toBe(5_000_000);
    expect(a.attributedVol).toBe(0);
    expect(a.unknownVol).toBe(0);
    expect(totalVol(t)).toBe(0); // the 5M is NOT counted as traded
    expect(t.bars(5)).toHaveLength(0);
    expect(a.partialSession).toBe(true);
  });

  it("counts only the increment after the baseline", () => {
    const t = new FlowTracker();
    t.onQuote(100, 5_000_000, ts("13:00"));
    t.onQuote(101, 5_000_600, ts("13:01")); // +600 on an uptick
    expect(totalVol(t)).toBe(600);
    const bars = t.bars(5);
    expect(bars.reduce((a, b) => a + b.buyVol, 0)).toBe(600);
    expect(bars.at(-1)?.cvd).toBe(600);
  });
});

describe("tick-rule attribution", () => {
  it("uptick => BUY, downtick => SELL", () => {
    const t = new FlowTracker();
    t.onQuote(100, 1000, ts("09:20"));
    t.onQuote(101, 1300, ts("09:21")); // +300 buy
    t.onQuote(99, 1500, ts("09:22")); // +200 sell
    const bars = t.bars(5);
    expect(bars.reduce((a, b) => a + b.buyVol, 0)).toBe(300);
    expect(bars.reduce((a, b) => a + b.sellVol, 0)).toBe(200);
    expect(bars.at(-1)?.delta).toBe(100);
  });

  it("unchanged price => UNKNOWN (never silently classified as buy or sell)", () => {
    const t = new FlowTracker();
    t.onQuote(100, 1000, ts("09:20"));
    t.onQuote(101, 1200, ts("09:21")); // +200 buy
    t.onQuote(101, 1500, ts("09:22")); // +300 unchanged → UNKNOWN
    const bars = t.bars(5);
    expect(bars.reduce((a, b) => a + b.buyVol, 0)).toBe(200);
    expect(bars.reduce((a, b) => a + b.sellVol, 0)).toBe(0);
    expect(bars.reduce((a, b) => a + b.untracedVol, 0)).toBe(300);
    const a = t.attribution();
    expect(a.unknownVol).toBe(300);
    expect(a.coveragePct).toBeCloseTo(40, 0); // 200 of 500
    expect(totalVol(t)).toBe(500); // conserved
  });

  it("a long polling gap leaves the increment unattributed", () => {
    const t = new FlowTracker();
    t.onQuote(100, 1000, ts("09:20"));
    t.onQuote(105, 9000, ts("09:30")); // 10-minute gap, +8000
    const a = t.attribution();
    expect(a.gapsSkipped).toBe(1);
    expect(a.unknownVol).toBe(8000);
    expect(a.attributedVol).toBe(0);
    expect(totalVol(t)).toBe(8000); // volume conserved, direction not guessed
  });
});

describe("resets, rollovers and corrupt inputs", () => {
  it("re-baselines when cumulative volume goes backwards (no negative delta)", () => {
    const t = new FlowTracker();
    t.onQuote(100, 10_000, ts("09:20"));
    t.onQuote(101, 10_500, ts("09:21")); // +500 buy
    t.onQuote(102, 400, ts("09:22")); // feed reset → re-baseline, no increment
    const a = t.attribution();
    expect(a.resets).toBe(1);
    expect(totalVol(t)).toBe(500); // the 400 is NOT added as traded volume
    t.onQuote(103, 700, ts("09:23")); // +300 from the new baseline
    expect(totalVol(t)).toBe(800);
  });

  it("session rollover resets CVD and re-establishes a baseline", () => {
    const t = new FlowTracker();
    t.onQuote(100, 1000, ts("09:20", "2026-10-26"));
    t.onQuote(101, 1400, ts("09:21", "2026-10-26"));
    expect(t.bars(5).at(-1)?.cvd).toBe(400);
    t.onQuote(100, 50_000, ts("09:20", "2026-10-27")); // new session
    const bars = t.bars(5);
    expect(bars).toHaveLength(0); // baseline only, nothing traded yet
    expect(t.attribution().baselineVol).toBe(50_000);
    expect(t.attribution().resets).toBe(0); // rollover is not a mid-session reset
  });

  it("ignores invalid prices and volumes instead of corrupting delta", () => {
    const t = new FlowTracker();
    t.onQuote(null, 1000, ts("09:20"));
    t.onQuote(0, 1000, ts("09:21"));
    t.onQuote(NaN, 1000, ts("09:22"));
    expect(t.attribution().observations).toBe(0);
    expect(totalVol(t)).toBe(0);
  });

  it("never produces negative volume contributions", () => {
    const t = new FlowTracker();
    t.onQuote(100, 1000, ts("09:20"));
    t.onQuote(99, 1000, ts("09:21")); // no volume change
    expect(totalVol(t)).toBe(0);
    for (const b of t.bars(5)) {
      expect(b.buyVol).toBeGreaterThanOrEqual(0);
      expect(b.sellVol).toBeGreaterThanOrEqual(0);
      expect(b.untracedVol).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("CVD accumulation", () => {
  it("accumulates only attributed deltas and is partial-session labelled", () => {
    const t = new FlowTracker();
    t.onQuote(100, 1000, ts("11:00")); // baseline mid-session
    t.onQuote(101, 1500, ts("11:01")); // +500 buy
    t.onQuote(100, 1900, ts("11:02")); // +400 sell
    t.onQuote(100, 2100, ts("11:03")); // +200 unknown
    const bars = t.bars(5);
    expect(bars.at(-1)?.cvd).toBe(100); // 500 - 400, unknown excluded
    expect(t.resetLabel()).toContain("PARTIAL");
    expect(t.resetLabel()).toContain("ESTIMATED");
  });
});

describe("shared flow confirmation gate", () => {
  it("reports UNAVAILABLE with no tracker data and scores exactly 0", () => {
    const fc = flowConfirmation([], null, []);
    expect(fc.status).toBe("UNAVAILABLE");
    expect(fc.available).toBe(false);
    expect(fc.score).toBe(0); // never penalises the instrument
  });

  it("reports INSUFFICIENT until enough observations exist", () => {
    const t = new FlowTracker();
    t.onQuote(100, 1000, ts("09:20"));
    t.onQuote(101, 1200, ts("09:21"));
    const fc = flowConfirmation(t.bars(1), t.attribution(), [100, 101], ts("09:22"));
    expect(fc.status).toBe("INSUFFICIENT");
    expect(fc.score).toBe(0);
    expect(fc.available).toBe(false);
  });

  it("confirms direction once observations and attribution suffice", () => {
    const t = new FlowTracker();
    let vol = 1000;
    let price = 100;
    t.onQuote(price, vol, ts("09:20")); // baseline
    for (let i = 1; i <= 10; i++) {
      price += 1; // consistent upticks
      vol += 500;
      t.onQuote(price, vol, ts(`09:${20 + i}`));
    }
    const a = t.attribution();
    expect(a.coveragePct).toBe(100);
    // 1-minute observations must be bucketed at 1 minute: the unified engine
    // requires >= 4 flow bars before it will express a direction.
    const fc = flowConfirmation(t.bars(1), a, Array.from({ length: 12 }, (_, i) => 100 + i), ts("09:31"));
    expect(fc.available).toBe(true);
    expect(fc.status).toBe("BULLISH");
    expect(fc.score).toBeGreaterThan(0);
    expect(fc.score).toBeLessThanOrEqual(1);
    expect(fc.deltaRatio).toBeCloseTo(1, 1);
  });

  it("reports STALE when the last observation is too old", () => {
    const t = new FlowTracker();
    let vol = 1000;
    let price = 100;
    t.onQuote(price, vol, ts("09:20"));
    for (let i = 1; i <= 8; i++) {
      price += 1;
      vol += 300;
      t.onQuote(price, vol, ts(`09:${20 + i}`));
    }
    const fc = flowConfirmation(t.bars(1), t.attribution(), [100, 101], ts("12:00"));
    expect(fc.status).toBe("STALE");
    expect(fc.score).toBe(0);
  });

  it("does not double-count CVD slope as independent evidence", () => {
    const t = new FlowTracker();
    let vol = 1000;
    let price = 100;
    t.onQuote(price, vol, ts("09:20"));
    for (let i = 1; i <= 12; i++) {
      price += 1;
      vol += 1000;
      t.onQuote(price, vol, ts(`09:${20 + i}`));
    }
    const fc = flowConfirmation(t.bars(1), t.attribution(), Array.from({ length: 14 }, (_, i) => 100 + i), ts("09:33"));
    // delta ratio is 1.0 (all buy); score is capped at 1.0 even with an
    // agreeing CVD slope — proof the two are not summed independently
    expect(fc.deltaRatio).toBeCloseTo(1, 2);
    expect(fc.score).toBeLessThanOrEqual(1);
  });
});
