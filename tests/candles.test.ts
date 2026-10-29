/**
 * Phase 9.23: candle sorting/dedup/session filter/resample invariants.
 */
import { describe, it, expect } from "vitest";
import { inSession, dedupeSort, resample, gapReport, bySession } from "../src/lib/market/candles";
import { Candle, istDateKey } from "../src/lib/market/types";

const BASE = Date.parse("2026-10-23T09:15:00+05:30");

function mk(min: number, p = 100): Candle {
  return { t: BASE + min * 60_000, o: p, h: p + 1, l: p - 1, c: p + 0.5, v: 100, closed: false };
}

describe("candle pipeline invariants", () => {
  it("dedupeSort removes duplicate timestamps and orders chronologically", () => {
    const out = dedupeSort([mk(2, 102), mk(0, 100), mk(1, 101), mk(0, 100)]);
    expect(out.map((c) => c.t)).toEqual([BASE, BASE + 60_000, BASE + 120_000]);
  });

  it("inSession keeps 09:15–15:40 IST bars and drops pre-market", () => {
    const pre = { ...mk(0), t: BASE - 5 * 60_000 };
    const good = mk(10);
    const after = { ...mk(0), t: BASE + (15 * 60 + 45 - 9 * 60 - 15) * 60_000 }; // 15:45
    expect(inSession([pre, good, after]).map((c) => c.t)).toEqual([good.t]);
  });

  it("resample anchors buckets to session open and never double-counts volume", () => {
    const oneMin = Array.from({ length: 10 }, (_, i) => mk(i, 100 + i));
    const five = resample(oneMin, 5, BASE + 10 * 60_000);
    expect(five).toHaveLength(2);
    expect(five[0].t).toBe(BASE);
    expect(five[0].o).toBe(100);
    expect(five[0].c).toBe(104.5);
    expect(five[0].v).toBe(500); // 5 × 100 exactly once
    expect(five[1].t).toBe(BASE + 5 * 60_000);
  });

  it("resample marks the forming bar as not closed, past bars closed", () => {
    const now = BASE + 7 * 60_000;
    const five = resample(Array.from({ length: 10 }, (_, i) => mk(i)), 5, now);
    expect(five[0].closed).toBe(true);
    expect(five[1].closed).toBe(false);
  });

  it("gapReport finds intra-session holes without inventing bars", () => {
    const cs = dedupeSort([mk(0), mk(1), mk(4), mk(5)]).map((c) => ({ ...c, closed: true }));
    const gaps = gapReport(cs, 1);
    expect(gaps).toHaveLength(2); // missing minutes 2 and 3
  });

  it("bySession splits on IST date", () => {
    const cs = [
      { ...mk(0), closed: true },
      { ...mk(0), t: BASE + 24 * 3_600_000, closed: true },
    ];
    const m = bySession(cs);
    expect(m.size).toBe(2);
    expect([...m.keys()]).toContain(istDateKey(BASE));
  });
});
