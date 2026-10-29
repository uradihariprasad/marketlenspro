/**
 * Phase 2.5 arithmetic tests: estimated Delta, CVD, session reset,
 * cumulative-volume reset, unchanged-price handling, footprint imbalance.
 */
import { describe, it, expect } from "vitest";
import { FlowTracker, footprintRows, flowContext } from "../src/lib/market/orderflow";
import { istDateKey, sessionOpenTs, FlowBar } from "../src/lib/market/types";

function sessionTs(hhmm: string, date = "2026-10-23"): number {
  // IST wall time → epoch ms
  const [h, m] = hhmm.split(":").map(Number);
  return Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000 - 5.5 * 3_600_000;
}

describe("estimated order flow (tick-rule)", () => {
  it("classifies upticks as buy, downticks as sell, and unchanged price as UNKNOWN", () => {
    const t = new FlowTracker();
    t.onQuote(100, 100, sessionTs("09:16")); // BASELINE only — 0 traded volume
    t.onQuote(101, 300, sessionTs("09:17")); // up, +200 → buy
    t.onQuote(99, 550, sessionTs("09:18")); // down, +250 → sell
    t.onQuote(99, 700, sessionTs("09:19")); // unchanged, +150 → UNKNOWN (never guessed)
    const bars = t.bars(5);
    const total = bars.reduce((a, b) => a + b.buyVol + b.sellVol + b.untracedVol, 0);
    expect(total).toBe(600); // 200+250+150 — the 100 baseline is NOT traded volume
    expect(bars.reduce((a, b) => a + b.buyVol, 0)).toBe(200);
    expect(bars.reduce((a, b) => a + b.sellVol, 0)).toBe(250);
    expect(bars.reduce((a, b) => a + b.untracedVol, 0)).toBe(150);
    expect(t.attribution().baselineVol).toBe(100);
    expect(bars[0].t).toBe(sessionOpenTs(istDateKey(sessionTs("09:16"))));
  });

  it("CVD accumulates per session and resets on a new session", () => {
    const t = new FlowTracker();
    t.onQuote(100, 100, sessionTs("09:16", "2026-10-22")); // baseline
    t.onQuote(101, 200, sessionTs("09:17", "2026-10-22")); // +100 buy
    expect(t.bars(5).at(-1)?.cvd).toBe(100);
    // new session → full reset, first observation is a baseline again
    t.onQuote(100, 50, sessionTs("09:16", "2026-10-23"));
    expect(t.bars(5)).toHaveLength(0); // nothing traded yet in the new session
    expect(t.attribution().baselineVol).toBe(50);
  });

  it("produces no traded volume when cumulative volume does not advance", () => {
    const t = new FlowTracker();
    t.onQuote(100, 500, sessionTs("09:16")); // baseline
    t.onQuote(101, 500, sessionTs("09:17")); // same cum → no increment
    const bars = t.bars(5);
    expect(bars.reduce((a, b) => a + b.buyVol + b.sellVol + b.untracedVol, 0)).toBe(0);
    expect(t.attribution().baselineVol).toBe(500);
  });

  it("footprint diagonal imbalance uses bid[i-1] vs ask[i] with min volume", () => {
    const bar: FlowBar = {
      t: 0,
      buyVol: 0,
      sellVol: 0,
      untracedVol: 0,
      delta: 0,
      cvd: 0,
      perPrice: {
        "100.00": { buy: 900, sell: 0 },
        "99.95": { buy: 0, sell: 250 }, // 900/250 = 3.6 ≥ 3 → BUY_IMBAL at 100.00
        "99.90": { buy: 0, sell: 10 },
      },
    };
    const rows = footprintRows(bar, 300, 3);
    const top = rows.find((r) => r.price === 100);
    expect(top?.imbalance).toBe("BUY_IMBAL");
    const low = rows.find((r) => r.price === 99.9);
    expect(low?.imbalance).toBeNull(); // insufficient volume
  });

  it("reports null context when no data exists — never fabricated", () => {
    const ctx = flowContext([]);
    expect(ctx.barDelta).toBeNull();
    expect(ctx.cvdNow).toBeNull();
    expect(ctx.divergence).toBeNull();
    expect(ctx.absorption).toBeNull();
  });
});
