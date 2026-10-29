/**
 * Phase 3.7 tests: S/R provenance separation, side polarity, clustering,
 * rejection semantics, missing-data behaviour.
 */
import { describe, it, expect } from "vitest";
import { buildZones } from "../src/lib/market/srEngine";
import { analyzeStructure } from "../src/lib/market/structure";
import { Candle } from "../src/lib/market/types";

/**
 * Synthetic session: rise to pivot high 150, dip to pivot low 140, peak 148,
 * settle 146 — both reference pivots stay within the zone-relevance window.
 */
function fixture(): Candle[] {
  const prices: number[] = [];
  for (let i = 0; i <= 10; i++) prices.push(100 + i * 5); // 100 → 150
  for (let i = 1; i <= 5; i++) prices.push(150 - i * 2); // → 140
  for (let i = 1; i <= 4; i++) prices.push(140 + i * 2); // → 148
  for (let i = 1; i <= 2; i++) prices.push(148 - i); // → 146
  const base = Date.parse("2026-10-23T09:15:00+05:30");
  return prices.map((p, i) => ({
    t: base + i * 300_000,
    o: p - 1, h: p + 1, l: p - 2, c: p, v: 1000 + i, closed: true,
  }));
}

function srInputs(candles: Candle[]) {
  return {
    instrumentKey: "TEST|X",
    timeframeMin: 5,
    candles,
    structure: analyzeStructure(candles),
    profile: null,
    oiLevels: null,
    tickSize: 0.05,
    atr: 4,
  };
}

describe("unified dynamic S/R engine", () => {
  it("classifies zones above price as RESISTANCE and below as SUPPORT", () => {
    const candles = fixture();
    const zones = buildZones(srInputs(candles));
    expect(zones.length).toBeGreaterThan(0);
    const lastClose = candles[candles.length - 1].c;
    for (const z of zones) {
      if (z.lower > lastClose) expect(z.side).toBe("RESISTANCE");
      if (z.upper < lastClose) expect(z.side).toBe("SUPPORT");
    }
    const res = zones.filter((z) => z.side === "RESISTANCE");
    const sup = zones.filter((z) => z.side === "SUPPORT");
    expect(res.length).toBeGreaterThan(0); // pivots at ~148/150
    expect(sup.length).toBeGreaterThan(0); // pivot at ~140
    expect(Math.min(...res.map((z) => z.lower)) > lastClose).toBe(true);
    expect(Math.max(...sup.map((z) => z.upper)) < lastClose).toBe(true);
    // the 150 pivot zone should be the nearest overhead resistance region
    expect(res.some((z) => z.mid > 147)).toBe(true);
    expect(sup.some((z) => z.mid < 143)).toBe(true);
  });

  it("keeps OI-only candidates in OI_CANDIDATE provenance regardless of weight", () => {
    const candles = fixture();
    const lastClose = candles[candles.length - 1].c;
    const zones = buildZones({
      ...srInputs(candles),
      oiLevels: [
        { strike: lastClose + 5, ceOi: 9_000_000, peOi: 100, ceOiChg: 500_000, peOiChg: 0 },
        { strike: lastClose - 5, ceOi: 50, peOi: 8_000_000, ceOiChg: -50_000, peOiChg: 200_000 },
      ],
    });
    const oi = zones.filter((z) => z.provenanceGroup === "OI_CANDIDATE");
    expect(oi.length).toBeGreaterThan(0);
    for (const z of oi) {
      // no fabricated confirmation: with no recorded wick rejections the
      // candidate must stay CANDIDATE even though its raw OI weight is high
      expect(z.confirmationStatus).toBe("CANDIDATE");
      expect(z.sources.some((s) => s.detail.includes("OI-only candidate"))).toBe(true);
    }
  });

  it("returns an empty zone list on empty/short history instead of fabricating", () => {
    const zones = buildZones(srInputs(fixture().slice(0, 5)));
    expect(zones).toEqual([]);
  });

  it("zones are tick-aligned and have sane ATR-based widths", () => {
    const zones = buildZones(srInputs(fixture()));
    for (const z of zones) {
      expect(z.lower).toBeLessThan(z.mid);
      expect(z.mid).toBeLessThan(z.upper);
      expect(Math.abs(z.lower / 0.05 - Math.round(z.lower / 0.05))).toBeLessThan(1e-6);
      const width = z.upper - z.lower;
      expect(width).toBeGreaterThan(0);
      expect(width).toBeLessThanOrEqual(4 * 0.35 + 0.067 + 0.05);
    }
  });

  it("zone ids are deterministic and dedupe across identical runs", () => {
    const a = buildZones(srInputs(fixture()));
    const b = buildZones(srInputs(fixture()));
    expect(a.map((z) => z.id).sort()).toEqual(b.map((z) => z.id).sort());
  });
});
