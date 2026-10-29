/**
 * S/R lifecycle + confirmation tests (Prompt §3).
 * Key rules under test:
 *  - a zone is NEVER confirmed by score alone; it needs price-action evidence
 *  - a break requires ACCEPTANCE (two closes beyond, or one close > 0.5·ATR)
 *  - primary support is below price, primary resistance above, broken excluded
 */
import { describe, it, expect } from "vitest";
import { buildZones, zoneMap } from "../src/lib/market/srEngine";
import { analyzeStructure } from "../src/lib/market/structure";
import { Candle, Zone } from "../src/lib/market/types";

const BASE = Date.parse("2026-10-26T09:15:00+05:30");
function series(prices: number[], wick = 1): Candle[] {
  return prices.map((p, i) => ({
    t: BASE + i * 300_000,
    o: p - 0.5, h: p + wick, l: p - wick, c: p, v: 1000 + i, closed: true,
  }));
}
function zonesFor(candles: Candle[], extra: Partial<Parameters<typeof buildZones>[0]> = {}): Zone[] {
  return buildZones({
    instrumentKey: "TEST|X",
    timeframeMin: 5,
    candles,
    structure: analyzeStructure(candles),
    profile: null,
    oiLevels: null,
    tickSize: 0.05,
    atr: 4,
    ...extra,
  });
}

/** rise to 150, pull back to 140, retest up to 148, settle 146 */
function fixture(): Candle[] {
  const p: number[] = [];
  for (let i = 0; i <= 10; i++) p.push(100 + i * 5);
  for (let i = 1; i <= 5; i++) p.push(150 - i * 2);
  for (let i = 1; i <= 4; i++) p.push(140 + i * 2);
  for (let i = 1; i <= 2; i++) p.push(148 - i);
  return series(p);
}

describe("zone confirmation requires price action, not score", () => {
  it("every CONFIRMED zone has a recorded reaction or tested consolidation", () => {
    const zones = zonesFor(fixture());
    expect(zones.length).toBeGreaterThan(0);
    for (const z of zones.filter((x) => x.confirmationStatus === "CONFIRMED")) {
      const reactions = z.touches.filter((t) => t.reaction !== "PASS").length;
      const consolidationTested = z.sources.some((s) => s.kind === "CONSOLIDATION") && z.touches.length >= 2;
      expect(reactions >= 1 || consolidationTested).toBe(true);
    }
  });

  it("a high-scoring zone with zero interaction stays CANDIDATE", () => {
    const zones = zonesFor(fixture());
    const untouched = zones.filter((z) => z.touches.length === 0);
    for (const z of untouched) {
      expect(z.confirmationStatus).toBe("CANDIDATE");
      expect(z.state).toBe("CANDIDATE");
    }
  });

  it("OI-only zones need two reactions and keep OI provenance forever", () => {
    const c = fixture();
    const last = c[c.length - 1].c;
    const zones = zonesFor(c, {
      oiLevels: [
        { strike: last + 4, ceOi: 9_000_000, peOi: 10, ceOiChg: 400_000, peOiChg: 0 },
        { strike: last - 4, ceOi: 10, peOi: 8_000_000, ceOiChg: 0, peOiChg: 300_000 },
      ],
    });
    const oi = zones.filter((z) => z.provenanceGroup === "OI_CANDIDATE");
    expect(oi.length).toBeGreaterThan(0);
    for (const z of oi) {
      const reactions = z.touches.filter((t) => t.reaction !== "PASS").length;
      if (z.confirmationStatus === "CONFIRMED") expect(reactions).toBeGreaterThanOrEqual(2);
      expect(z.provenanceGroup).toBe("OI_CANDIDATE"); // provenance preserved
    }
  });
});

describe("break requires acceptance, not a single wick", () => {
  it("a lone wick beyond a level does not mark it BROKEN", () => {
    // flat base at 100 with ONE long upper wick to 130, closing back at 100
    const prices = Array.from({ length: 40 }, () => 100);
    const candles = series(prices, 0.6);
    candles[20] = { ...candles[20], h: 130, c: 100 }; // spike wick only
    const zones = zonesFor(candles, { atr: 2 });
    for (const z of zones) {
      // nothing closed beyond any zone, so nothing may be BROKEN
      expect(z.state).not.toBe("BROKEN");
    }
  });

  it("two consecutive closes accepted beyond a level mark it BROKEN", () => {
    // base 100-103, then decisive acceptance BELOW it. The level now sits
    // above price (so it is classified RESISTANCE) and must read BROKEN.
    const prices = [
      ...Array.from({ length: 24 }, (_, i) => 100 + (i % 4)),
      ...Array.from({ length: 6 }, () => 104), // probe up (forms pivots)
      96, 95, // two consecutive closes accepted below the base
    ];
    const zones = zonesFor(series(prices, 0.5), { atr: 2 });
    const broken = zones.filter((z) => z.state === "BROKEN");
    expect(broken.length).toBeGreaterThan(0);
    for (const z of broken) expect(z.lower).toBeGreaterThan(95);
  });

  it("an upside acceptance flips a resistance into support rather than deleting it", () => {
    const prices = [
      ...Array.from({ length: 24 }, (_, i) => 100 + (i % 4)),
      ...Array.from({ length: 8 }, () => 97),
      107, 108, // accepted above the base
    ];
    const zones = zonesFor(series(prices, 0.5), { atr: 2 });
    const below = zones.filter((z) => z.upper < 108);
    expect(below.length).toBeGreaterThan(0);
    for (const z of below) expect(z.side).toBe("SUPPORT"); // polarity flip
  });
});

describe("primary S/R selection", () => {
  it("support sits below price and resistance above", () => {
    const c = fixture();
    const price = c[c.length - 1].c;
    const zones = zonesFor(c);
    const { nearestSupport, nearestResistance } = zoneMap(price, zones);
    if (nearestSupport) expect(nearestSupport.mid).toBeLessThanOrEqual(price);
    if (nearestResistance) expect(nearestResistance.mid).toBeGreaterThanOrEqual(price);
  });

  it("prefers an intact zone over a BROKEN one at the same side", () => {
    const price = 100;
    const mk = (mid: number, state: Zone["state"]): Zone => ({
      id: `z${mid}${state}`, instrumentKey: "T|X", timeframeMin: 5,
      side: mid < price ? "SUPPORT" : "RESISTANCE",
      lower: mid - 0.3, upper: mid + 0.3, mid,
      provenanceGroup: "STRUCTURAL", confirmationStatus: "CONFIRMED",
      state, score: 2, breakdown: [], sources: [], touches: [],
      invalidation: mid, createdAt: 0, updatedAt: 0,
    });
    // a BROKEN level sits closer below price than an intact one
    const zones = [mk(99, "BROKEN"), mk(98, "STRENGTHENING"), mk(102, "CONFIRMED")];
    const { nearestSupport } = zoneMap(price, zones);
    expect(nearestSupport?.mid).toBe(98); // intact preferred over the closer broken level
    expect(nearestSupport?.state).not.toBe("BROKEN");
  });

  it("falls back to a traversed level rather than reporting no resistance, keeping its BROKEN state", () => {
    const price = 100;
    const broken: Zone = {
      id: "zb", instrumentKey: "T|X", timeframeMin: 5, side: "RESISTANCE",
      lower: 101, upper: 101.6, mid: 101.3,
      provenanceGroup: "STRUCTURAL", confirmationStatus: "CONFIRMED",
      state: "BROKEN", score: 2, breakdown: [], sources: [], touches: [],
      invalidation: 102, createdAt: 0, updatedAt: 0,
    };
    const { nearestResistance } = zoneMap(price, [broken]);
    // the level is still the nearest structural reference overhead...
    expect(nearestResistance?.mid).toBe(101.3);
    // ...but it is never presented as intact — the state travels with it
    expect(nearestResistance?.state).toBe("BROKEN");
  });

  it("returns nulls rather than inventing levels when there are no zones", () => {
    const m = zoneMap(100, []);
    expect(m.nearestSupport).toBeNull();
    expect(m.nearestResistance).toBeNull();
    expect(m.distSupPct).toBeNull();
  });
});

describe("volume profile levels feed the zone engine", () => {
  it("HVN, LVN and VWAP appear as zone sources when supplied", () => {
    const c = fixture();
    const price = c.at(-1)!.c;
    const zones = zonesFor(c, {
      profile: {
        mode: "APPROXIMATE",
        poc: price - 1,
        vah: price + 3,
        val: price - 5,
        hvn: [price - 2],
        lvn: [price + 2],
        binSize: 0.5,
        bins: [],
        totalVolume: 10_000,
        note: "test",
      },
      vwap: price + 0.5,
    });
    const kinds = new Set(zones.flatMap((z) => z.sources.map((s) => s.kind)));
    expect(kinds.has("PROFILE_HVN") || kinds.has("PROFILE_LVN")).toBe(true);
    expect(kinds.has("VWAP")).toBe(true);
    // profile-derived sources are labelled ESTIMATED, never exchange data
    const profileSrc = zones.flatMap((z) => z.sources).filter((s) => s.kind.startsWith("PROFILE_"));
    for (const s of profileSrc) expect(s.detail).toMatch(/ESTIMATED/i);
  });
});
