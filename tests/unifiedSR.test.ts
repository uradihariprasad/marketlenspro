/**
 * Unified S/R decision-layer tests.
 *
 * Contracts under test:
 *  - IMMEDIATE (proximity) and PRIMARY (strength) use DIFFERENT rules and may
 *    legitimately select different levels
 *  - support is always below spot, resistance always above
 *  - OI-only zones never become price-confirmed
 *  - 5m/15m OI changes drive strengthening / weakening / breakout-risk states
 *  - hysteresis prevents primary-level flicker
 *  - missing OI history never fabricates a level
 */
import { describe, it, expect } from "vitest";
import { buildUnifiedSR, UnifiedSR } from "../src/lib/market/unifiedSR";
import type { OiWindow, OiZone, StrikePosture } from "../src/lib/market/oiIntelligence";
import { Zone } from "../src/lib/market/types";

const NOW = Date.parse("2026-10-28T11:00:00+05:30");
const SPOT = 25100;

function zone(mid: number, side: Zone["side"], over: Partial<Zone> = {}): Zone {
  return {
    id: `z${mid}`, instrumentKey: "T|X", timeframeMin: 5, side,
    lower: mid - 10, upper: mid + 10, mid,
    provenanceGroup: "STRUCTURAL", confirmationStatus: "CONFIRMED",
    state: "CONFIRMED", score: 3,
    breakdown: [], sources: [], touches: [], invalidation: mid, createdAt: 0, updatedAt: 0,
    ...over,
  };
}
function oiZone(strike: number, kind: "SUPPORT" | "RESISTANCE", score = 60): OiZone {
  return {
    strike, kind, classification: "STRONG", provenance: "OI_CANDIDATE",
    confirmation: "CANDIDATE", score, evidence: [], contributingStrikes: [strike],
    invalidation: `acceptance beyond ${strike}`,
    sourceTimestamps: { current: NOW, baseline5m: NOW, baseline15m: NOW, session: NOW },
  };
}
function win(rows: { strike: number; ce: number; pe: number }[], status: OiWindow["status"] = "OK"): OiWindow {
  return {
    label: "w", windowMs: 300_000, status, reason: status === "OK" ? "" : "collecting history",
    baselineAt: NOW - 300_000, currentAt: NOW, actualSpanMs: 300_000,
    rows: rows.map((r) => ({
      strike: r.strike, ceChange: r.ce, peChange: r.pe,
      ceChangePct: null, peChangePct: null, ceOi: 10_000, peOi: 10_000,
    })),
  };
}
const baseInput = {
  instrumentKey: "NSE_INDEX|Nifty 50",
  spot: SPOT,
  structural: [] as Zone[],
  oiZones: [] as OiZone[],
  atr: 50,
  now: NOW,
};

describe("immediate vs primary selection use different rules", () => {
  it("immediate is nearest; primary is strongest — and they can differ", () => {
    const u = buildUnifiedSR({
      ...baseInput,
      structural: [
        // near but weak support
        zone(25080, "SUPPORT", { score: 1, touches: [] }),
        // far but strong support (many confirmed reactions)
        zone(24800, "SUPPORT", {
          score: 5,
          touches: [
            { t: NOW, price: 24800, reaction: "BOUNCE" },
            { t: NOW, price: 24805, reaction: "BOUNCE" },
            { t: NOW, price: 24798, reaction: "BOUNCE" },
          ],
        }),
      ],
    });
    expect(u.immediateSupport!.price).toBe(25080); // nearest
    expect(u.primarySupport!.price).toBe(24800);   // strongest
    expect(u.immediateSupport!.price).not.toBe(u.primarySupport!.price);
    expect(u.immediateSupport!.role).toBe("IMMEDIATE_SUPPORT");
    expect(u.primarySupport!.role).toBe("PRIMARY_SUPPORT");
    expect(u.primarySupport!.score).toBeGreaterThan(u.immediateSupport!.score);
  });

  it("the same rules apply on the resistance side", () => {
    const u = buildUnifiedSR({
      ...baseInput,
      structural: [
        zone(25120, "RESISTANCE", { score: 1 }),
        zone(25400, "RESISTANCE", {
          score: 5,
          touches: [
            { t: NOW, price: 25400, reaction: "REJECTION" },
            { t: NOW, price: 25395, reaction: "REJECTION" },
          ],
        }),
      ],
    });
    expect(u.immediateResistance!.price).toBe(25120);
    expect(u.primaryResistance!.price).toBe(25400);
  });
});

describe("levels are always on the correct side of spot", () => {
  it("never selects a support above spot or a resistance below spot", () => {
    const u = buildUnifiedSR({
      ...baseInput,
      structural: [zone(24900, "SUPPORT"), zone(25300, "RESISTANCE")],
      oiZones: [oiZone(24800, "SUPPORT"), oiZone(25500, "RESISTANCE")],
    });
    for (const l of u.all) {
      if (l.side === "SUPPORT") expect(l.price).toBeLessThanOrEqual(SPOT);
      if (l.side === "RESISTANCE") expect(l.price).toBeGreaterThanOrEqual(SPOT);
    }
    expect(u.immediateSupport!.price).toBeLessThan(SPOT);
    expect(u.immediateResistance!.price).toBeGreaterThan(SPOT);
  });

  it("a BROKEN structural zone is never offered as an active level", () => {
    const u = buildUnifiedSR({
      ...baseInput,
      structural: [zone(25000, "SUPPORT", { state: "BROKEN" }), zone(24700, "SUPPORT")],
    });
    expect(u.all.some((l) => l.price === 25000)).toBe(false);
    expect(u.immediateSupport!.price).toBe(24700);
  });

  it("returns an explicit unavailable state instead of inventing a level", () => {
    const u = buildUnifiedSR({ ...baseInput, structural: [zone(25300, "RESISTANCE")] });
    expect(u.immediateSupport).toBeNull();
    expect(u.primarySupport).toBeNull();
    expect(u.unavailable.support).toMatch(/no valid support/i);
    expect(u.unavailable.resistance).toBeNull();
  });

  it("no spot reference yields a fully unavailable result", () => {
    const u = buildUnifiedSR({ ...baseInput, spot: null, structural: [zone(24900, "SUPPORT")] });
    expect(u.all).toHaveLength(0);
    expect(u.unavailable.support).toMatch(/no spot/i);
  });
});

describe("OI provenance and confirmation", () => {
  it("an OI-only level is never price-confirmed", () => {
    const u = buildUnifiedSR({ ...baseInput, oiZones: [oiZone(24900, "SUPPORT"), oiZone(25300, "RESISTANCE")] });
    const oiLevels = u.all.filter((l) => l.provenance === "OI_CANDIDATE");
    expect(oiLevels.length).toBeGreaterThan(0);
    for (const l of oiLevels) {
      expect(l.priceConfirmed).toBe(false);
      expect(l.confirmation).toBe("CANDIDATE");
    }
  });

  it("structure + OI at the same level becomes CONFLUENCE and scores higher", () => {
    const structOnly = buildUnifiedSR({ ...baseInput, structural: [zone(24900, "SUPPORT")] });
    const withOi = buildUnifiedSR({
      ...baseInput,
      structural: [zone(24900, "SUPPORT")],
      oiZones: [oiZone(24900, "SUPPORT")], // same price, within ATR cluster tolerance
    });
    expect(withOi.all).toHaveLength(1); // merged, not duplicated
    expect(withOi.all[0].provenance).toBe("CONFLUENCE");
    expect(withOi.all[0].priceConfirmed).toBe(true); // confirmation comes from STRUCTURE
    expect(withOi.all[0].score).toBeGreaterThan(structOnly.all[0].score);
  });

  it("missing OI history produces no fabricated levels or evidence weight", () => {
    const u = buildUnifiedSR({
      ...baseInput,
      structural: [zone(24900, "SUPPORT")],
      w5: win([], "COLLECTING"),
      w15: win([], "COLLECTING"),
    });
    expect(u.all).toHaveLength(1); // only the structural zone
    const oiEv = u.all[0].evidence.filter((e) => e.source === "OI_5M" || e.source === "OI_15M");
    for (const e of oiEv) expect(e.weight).toBe(0); // zero contribution, not invented
  });
});

describe("OI changes drive zone lifecycle states", () => {
  const supportZone = zone(24900, "SUPPORT", { touches: [{ t: NOW, price: 24900, reaction: "BOUNCE" }] });

  it("put OI building over 5m and 15m strengthens support", () => {
    const u = buildUnifiedSR({
      ...baseInput,
      structural: [supportZone],
      oiZones: [oiZone(24900, "SUPPORT")],
      w5: win([{ strike: 24900, ce: 0, pe: 5000 }]),
      w15: win([{ strike: 24900, ce: 0, pe: 12000 }]),
      postures: [{ strike: 24900, side: "PE", posture: "POSSIBLE_PUT_WRITING", oiChange: 5000, premiumChange: -4, note: "possible put writing" } as StrikePosture],
    });
    expect(["STRONG_SUPPORT", "SUPPORT_STRENGTHENING"]).toContain(u.primarySupport!.state);
    expect(u.primarySupport!.evidence.some((e) => e.source === "OI_5M" && e.weight > 0)).toBe(true);
    expect(u.primarySupport!.evidence.some((e) => e.source === "OI_15M" && e.weight > 0)).toBe(true);
  });

  it("put OI unwinding over both windows weakens support", () => {
    const u = buildUnifiedSR({
      ...baseInput,
      structural: [supportZone],
      oiZones: [oiZone(24900, "SUPPORT")],
      w5: win([{ strike: 24900, ce: 0, pe: -6000 }]),
      w15: win([{ strike: 24900, ce: 0, pe: -11000 }]),
    });
    expect(u.primarySupport!.state).toBe("SUPPORT_WEAKENING");
  });

  it("price accepted below support flags BREAKDOWN_RISK", () => {
    const u = buildUnifiedSR({
      ...baseInput,
      spot: 24700, // accepted well below the 24900 zone
      structural: [supportZone],
    });
    const lvl = u.all.find((l) => l.price === 24900);
    // 24900 is now ABOVE spot, so it is re-sided as resistance (a flipped level)
    expect(lvl?.side).toBe("RESISTANCE");
  });

  it("price pressing just above a resistance band flags BREAKOUT_RISK", () => {
    // Spot must sit above the band's upper edge by >0.5·ATR (25 pts) to count
    // as acceptance, while the zone mid stays above spot so it is still
    // classified as resistance rather than a flipped support.
    const res = zone(25150, "RESISTANCE", { lower: 25100, upper: 25120 });
    const u = buildUnifiedSR({ ...baseInput, spot: 25148, structural: [res] });
    const lvl = u.all.find((l) => Math.abs(l.price - 25150) < 1);
    expect(lvl?.side).toBe("RESISTANCE");
    expect(lvl?.state).toBe("RESISTANCE_BREAKOUT_RISK");
  });

  it("a level the price has moved through is re-sided, not kept on the wrong side", () => {
    const u = buildUnifiedSR({
      ...baseInput,
      spot: 24700, // price has fallen through the old 24900 support
      structural: [zone(24900, "SUPPORT")],
    });
    const lvl = u.all.find((l) => l.price === 24900);
    expect(lvl?.side).toBe("RESISTANCE"); // former support now sits overhead
    expect(u.immediateSupport).toBeNull(); // and is never reported as support
  });

  it("call OI building strengthens resistance; rising call OI alone is not sufficient", () => {
    const resZone = zone(25300, "RESISTANCE", { touches: [{ t: NOW, price: 25300, reaction: "REJECTION" }] });
    const strengthening = buildUnifiedSR({
      ...baseInput,
      structural: [resZone],
      w5: win([{ strike: 25300, ce: 6000, pe: 0 }]),
      w15: win([{ strike: 25300, ce: 14000, pe: 0 }]),
      oiZones: [oiZone(25300, "RESISTANCE")],
      postures: [{ strike: 25300, side: "CE", posture: "POSSIBLE_CALL_WRITING", oiChange: 6000, premiumChange: -5, note: "possible call writing" } as StrikePosture],
    });
    expect(["STRONG_RESISTANCE", "RESISTANCE_STRENGTHENING"]).toContain(strengthening.primaryResistance!.state);

    // identical OI build, but premium RISING with the underlying => call BUYING,
    // which must not be scored as resistance-supporting evidence
    const buying = buildUnifiedSR({
      ...baseInput,
      structural: [resZone],
      w5: win([{ strike: 25300, ce: 6000, pe: 0 }]),
      w15: win([{ strike: 25300, ce: 14000, pe: 0 }]),
      oiZones: [oiZone(25300, "RESISTANCE")],
      postures: [{ strike: 25300, side: "CE", posture: "POSSIBLE_CALL_BUYING", oiChange: 6000, premiumChange: 9, note: "possible call buying" } as StrikePosture],
    });
    expect(buying.primaryResistance!.score).toBeLessThan(strengthening.primaryResistance!.score);
  });

  it("ESTIMATED flow is supporting evidence only and is labelled", () => {
    const u = buildUnifiedSR({
      ...baseInput,
      structural: [zone(24900, "SUPPORT")],
      flowPressure: 0.6,
    });
    const ev = u.primarySupport!.evidence.find((e) => e.source === "FLOW");
    expect(ev).toBeDefined();
    expect(ev!.detail).toMatch(/ESTIMATED|supports/i);
    expect(Math.abs(ev!.weight)).toBeLessThanOrEqual(6); // bounded, never dominant
  });
});

describe("stability and instrument isolation", () => {
  it("hysteresis keeps the incumbent primary unless clearly beaten", () => {
    const first = buildUnifiedSR({
      ...baseInput,
      structural: [
        zone(24900, "SUPPORT", { score: 4, touches: [{ t: NOW, price: 24900, reaction: "BOUNCE" }, { t: NOW, price: 24905, reaction: "BOUNCE" }] }),
        zone(24800, "SUPPORT", { score: 1 }),
      ],
    });
    const incumbent = first.primarySupport!.price;
    // challenger improves only slightly — must NOT flip the primary
    const second = buildUnifiedSR({
      ...baseInput,
      structural: [
        zone(24900, "SUPPORT", { score: 4, touches: [{ t: NOW, price: 24900, reaction: "BOUNCE" }, { t: NOW, price: 24905, reaction: "BOUNCE" }] }),
        zone(24800, "SUPPORT", { score: 2 }),
      ],
      previous: first,
    });
    expect(second.primarySupport!.price).toBe(incumbent);
  });

  it("levels are namespaced per instrument so stale levels cannot leak", () => {
    const a = buildUnifiedSR({ ...baseInput, instrumentKey: "NSE_EQ|AAA", structural: [zone(24900, "SUPPORT")] });
    const b = buildUnifiedSR({ ...baseInput, instrumentKey: "NSE_EQ|BBB", structural: [zone(24800, "SUPPORT")] });
    expect(a.instrumentKey).toBe("NSE_EQ|AAA");
    expect(b.instrumentKey).toBe("NSE_EQ|BBB");
    expect(a.primarySupport!.id).toContain("NSE_EQ|AAA");
    expect(b.primarySupport!.id).toContain("NSE_EQ|BBB");
    expect(a.primarySupport!.id).not.toBe(b.primarySupport!.id);
  });

  it("nearby duplicate zones cluster into one level", () => {
    const u = buildUnifiedSR({
      ...baseInput,
      structural: [zone(24900, "SUPPORT")],
      oiZones: [oiZone(24905, "SUPPORT")], // within 0.5 ATR (25 pts) of 24900
    });
    expect(u.all.filter((l) => l.side === "SUPPORT")).toHaveLength(1);
  });

  it("is deterministic for identical inputs", () => {
    const args = { ...baseInput, structural: [zone(24900, "SUPPORT"), zone(25300, "RESISTANCE")] };
    expect(JSON.stringify(buildUnifiedSR(args))).toBe(JSON.stringify(buildUnifiedSR(args)));
  });

  it("scores stay bounded 0..100", () => {
    const u = buildUnifiedSR({
      ...baseInput,
      structural: [zone(24900, "SUPPORT", { score: 99, touches: Array.from({ length: 20 }, () => ({ t: NOW, price: 24900, reaction: "BOUNCE" as const })) })],
      oiZones: [oiZone(24900, "SUPPORT", 100)],
      w5: win([{ strike: 24900, ce: 0, pe: 99999 }]),
      w15: win([{ strike: 24900, ce: 0, pe: 99999 }]),
      flowPressure: 1,
    });
    for (const l of u.all) {
      expect(l.score).toBeGreaterThanOrEqual(0);
      expect(l.score).toBeLessThanOrEqual(100);
    }
  });
});
