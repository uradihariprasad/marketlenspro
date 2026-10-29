/**
 * OI Strike Intelligence tests.
 *
 * Core contracts:
 *  - 5m / 15m / session windows each come from REAL timestamped observations
 *    (15m is never 5m × 3), and are UNAVAILABLE until a genuine baseline exists
 *  - CE/PE are kept separate; strike interval and ATM come from real data
 *  - expiry rollover starts a new series (no cross-contract comparison)
 *  - a single OI decline can never trigger exhaustion
 *  - conflicting 5m vs 15m is surfaced, never forced into a direction
 *  - OI zones stay CANDIDATE provenance
 */
import { describe, it, expect } from "vitest";
import {
  OiHistory, OiObservation, StrikeObservation,
  buildWindow, buildOiZones, classifyOiMomentum, classifyPosture,
  inferStrikeInterval, resolveAtm, focusBand,
} from "../src/lib/market/oiIntelligence";

const BASE = Date.parse("2026-10-27T10:00:00+05:30");
const LADDER = [24800, 24900, 25000, 25100, 25200, 25300, 25400];

function obs(tOffsetMs: number, ceBase: number, peBase: number, spot = 25100, premiumCe = 100, premiumPe = 100): OiObservation {
  const strikes = new Map<number, StrikeObservation>();
  LADDER.forEach((strike, i) => {
    strikes.set(strike, {
      strike,
      ceOi: ceBase + i * 1000,
      peOi: peBase + i * 500,
      ceLtp: premiumCe,
      peLtp: premiumPe,
      ceVol: 100,
      peVol: 100,
    });
  });
  return { t: BASE + tOffsetMs, spot, expiry: "2026-10-29", strikes };
}

describe("timestamped observation history", () => {
  it("rejects duplicate/out-of-order observations", () => {
    const h = new OiHistory();
    h.record("NSE_INDEX|Nifty 50", "2026-10-29", obs(0, 10_000, 8_000));
    h.record("NSE_INDEX|Nifty 50", "2026-10-29", obs(0, 99_000, 99_000)); // duplicate t
    h.record("NSE_INDEX|Nifty 50", "2026-10-29", obs(-5000, 1, 1)); // older
    expect(h.all("NSE_INDEX|Nifty 50", "2026-10-29")).toHaveLength(1);
  });

  it("isolates series per underlying AND per expiry", () => {
    const h = new OiHistory();
    h.record("A", "2026-10-29", obs(0, 10_000, 8_000));
    h.record("A", "2026-11-26", obs(0, 20_000, 9_000));
    h.record("B", "2026-10-29", obs(0, 30_000, 7_000));
    expect(h.all("A", "2026-10-29")).toHaveLength(1);
    expect(h.all("A", "2026-11-26")).toHaveLength(1);
    expect(h.all("B", "2026-10-29")).toHaveLength(1);
    // clearing one expiry leaves the other intact
    h.clear("A", "2026-10-29");
    expect(h.all("A", "2026-10-29")).toHaveLength(0);
    expect(h.all("A", "2026-11-26")).toHaveLength(1);
  });

  it("returns no baseline until an observation is genuinely old enough", () => {
    const h = new OiHistory();
    h.record("A", "E", obs(0, 10_000, 8_000));
    h.record("A", "E", obs(60_000, 10_500, 8_200)); // 1 min later
    const now = BASE + 60_000;
    expect(h.baselineFor("A", "E", 5 * 60_000, now)).toBeNull();   // no 5m history
    expect(h.baselineFor("A", "E", 15 * 60_000, now)).toBeNull();  // no 15m history
  });

  it("selects the observation closest to the requested window", () => {
    const h = new OiHistory();
    for (let m = 0; m <= 20; m++) h.record("A", "E", obs(m * 60_000, 10_000 + m * 10, 8_000));
    const now = BASE + 20 * 60_000;
    const b5 = h.baselineFor("A", "E", 5 * 60_000, now);
    const b15 = h.baselineFor("A", "E", 15 * 60_000, now);
    expect(b5!.t).toBe(BASE + 15 * 60_000); // 5 minutes before now
    expect(b15!.t).toBe(BASE + 5 * 60_000); // 15 minutes before now
    expect(b5!.t).not.toBe(b15!.t);         // independent baselines
  });
});

describe("window computation", () => {
  it("5m and 15m are computed independently — 15m is NOT 5m × 3", () => {
    const h = new OiHistory();
    // OI rises fast in the last 5 minutes, flat before that
    for (let m = 0; m <= 20; m++) {
      const ce = m >= 15 ? 10_000 + (m - 15) * 1000 : 10_000;
      h.record("A", "E", obs(m * 60_000, ce, 8_000));
    }
    const now = BASE + 20 * 60_000;
    const cur = h.latest("A", "E");
    const w5 = buildWindow("5m", 5 * 60_000, cur, h.baselineFor("A", "E", 5 * 60_000, now), LADDER, 2, 21);
    const w15 = buildWindow("15m", 15 * 60_000, cur, h.baselineFor("A", "E", 15 * 60_000, now), LADDER, 2, 21);
    expect(w5.status).toBe("OK");
    expect(w15.status).toBe("OK");
    const ce5 = w5.rows[0].ceChange!;
    const ce15 = w15.rows[0].ceChange!;
    expect(ce5).toBe(5000);
    expect(ce15).toBe(5000);       // the build happened entirely inside 5m
    expect(ce15).not.toBe(ce5 * 3); // proves independent calculation
  });

  it("reports COLLECTING with a reason instead of inventing values", () => {
    const w = buildWindow("15m", 15 * 60_000, obs(0, 10_000, 8_000), null, LADDER, 2, 1);
    expect(w.status).toBe("COLLECTING");
    expect(w.rows).toHaveLength(0);
    expect(w.reason).toMatch(/collecting|no valid observation/i);
  });

  it("keeps CE and PE separate and computes percentage change", () => {
    const h = new OiHistory();
    h.record("A", "E", obs(0, 10_000, 8_000));
    h.record("A", "E", obs(6 * 60_000, 12_000, 7_000)); // CE +2000, PE -1000
    const now = BASE + 6 * 60_000;
    const w = buildWindow("5m", 5 * 60_000, h.latest("A", "E"), h.baselineFor("A", "E", 5 * 60_000, now), LADDER, 2, 2);
    expect(w.status).toBe("OK");
    const r = w.rows[0];
    expect(r.ceChange).toBe(2000);
    expect(r.peChange).toBe(-1000);
    expect(r.ceChangePct).toBeCloseTo(20, 1);   // 2000 / 10000
    expect(r.peChangePct).toBeCloseTo(-12.5, 1); // -1000 / 8000
  });

  it("a strike missing from the baseline yields null, not zero", () => {
    const cur = obs(5 * 60_000, 10_000, 8_000);
    const base = obs(0, 10_000, 8_000);
    base.strikes.delete(25000); // contract absent earlier
    const w = buildWindow("5m", 5 * 60_000, cur, base, LADDER, 2, 2);
    const row = w.rows.find((r) => r.strike === 25000)!;
    expect(row.ceChange).toBeNull();
    expect(row.peChange).toBeNull();
  });
});

describe("ladder, ATM and focus band", () => {
  it("infers the strike interval from real data", () => {
    expect(inferStrikeInterval(LADDER)).toBe(100);
    expect(inferStrikeInterval([1000, 1020, 1040, 1060])).toBe(20);
    expect(inferStrikeInterval([500])).toBeNull();
  });

  it("resolves ATM as the closest strike and recalculates as spot moves", () => {
    expect(resolveAtm(LADDER, 25080)).toBe(25100);
    expect(resolveAtm(LADDER, 24930)).toBe(24900);
    expect(resolveAtm(LADDER, null)).toBeNull();
  });

  it("focus band is ATM ±3 from the actual ladder, clamped at the edges", () => {
    expect(focusBand(LADDER, 25100)).toEqual([24800, 24900, 25000, 25100, 25200, 25300, 25400]);
    const band = focusBand(LADDER, 24900);
    expect(band).toContain(24900);
    expect(band.length).toBeLessThanOrEqual(7);
    expect(band[0]).toBe(24800); // clamped, never out of range
  });
});

describe("positioning interpretation", () => {
  it("rising call OI + falling premium + stalling underlying => possible call writing", () => {
    const r = classifyPosture("CE", 5000, -12, -5);
    expect(r.posture).toBe("POSSIBLE_CALL_WRITING");
    expect(r.note).toMatch(/possible call writing/i);
    expect(r.note).toMatch(/requires rejection evidence/i); // never auto-resistance
  });

  it("rising call OI + rising premium + rising underlying => possible call buying", () => {
    const r = classifyPosture("CE", 5000, 14, 30);
    expect(r.posture).toBe("POSSIBLE_CALL_BUYING");
    expect(r.note).toMatch(/NOT automatically resistance/i);
  });

  it("rising put OI + falling premium + holding underlying => possible put writing", () => {
    const r = classifyPosture("PE", 4000, -9, 12);
    expect(r.posture).toBe("POSSIBLE_PUT_WRITING");
    expect(r.note).toMatch(/requires acceptance evidence/i);
  });

  it("rising put OI + rising premium + falling underlying => possible put buying", () => {
    const r = classifyPosture("PE", 4000, 11, -25);
    expect(r.posture).toBe("POSSIBLE_PUT_BUYING");
    expect(r.note).toMatch(/NOT automatically support/i);
  });

  it("falling OI distinguishes short covering from long unwinding", () => {
    expect(classifyPosture("CE", -3000, 8, 10).note).toMatch(/short covering/i);
    expect(classifyPosture("CE", -3000, -8, -10).note).toMatch(/long unwinding/i);
  });
});

describe("momentum and exhaustion", () => {
  const okWindow = (ce: number, pe: number, spanMin = 5): ReturnType<typeof buildWindow> => ({
    label: "w", windowMs: spanMin * 60_000, status: "OK", reason: "", baselineAt: BASE,
    currentAt: BASE + spanMin * 60_000, actualSpanMs: spanMin * 60_000,
    rows: [{ strike: 25100, ceChange: ce, peChange: pe, ceChangePct: null, peChangePct: null, ceOi: 10_000, peOi: 10_000 }],
  });

  it("surfaces CONFLICTING signals rather than forcing a direction", () => {
    const m = classifyOiMomentum({
      w5: okWindow(0, 5000),            // bullish (put writing)
      w15: okWindow(5000, 0, 15),       // bearish (call writing)
      session: okWindow(5000, 0, 15),
      underlyingChangePct: 0.1, priceConfirms: true, flowPressure: 0.3,
    });
    expect(m.state).toBe("CONFLICTING_OI_SIGNALS");
    expect(m.agreement).toBe("CONFLICTING");
  });

  it("a single OI decline does NOT trigger exhaustion", () => {
    const m = classifyOiMomentum({
      // 5m rate 100/min vs 15m rate 600/min => fading (ONE piece of evidence)
      w5: okWindow(0, 500),
      w15: okWindow(0, 9000, 15),
      session: okWindow(0, 9000, 15),
      underlyingChangePct: 0.4, priceConfirms: true, flowPressure: 0.4,
    });
    expect(m.state).toBe("MOMENTUM_WEAKENING");  // weakening, NOT exhaustion
    expect(m.exhaustionEvidence).toHaveLength(1);
  });

  it("multiple weakening observations give POSSIBLE_EXHAUSTION", () => {
    const m = classifyOiMomentum({
      w5: okWindow(0, 500),
      w15: okWindow(0, 9000, 15),   // fading
      session: okWindow(0, 9000, 15),
      underlyingChangePct: -0.5,   // underlying disagrees
      priceConfirms: false,        // price unconfirmed
      flowPressure: -0.4,          // flow opposes
    });
    expect(m.state).toBe("POSSIBLE_EXHAUSTION");
    expect(m.exhaustionEvidence.length).toBeGreaterThanOrEqual(2);
  });

  it("aligned, accelerating and price-confirmed => momentum strengthening", () => {
    const m = classifyOiMomentum({
      // 5m rate 1800/min vs 15m rate 267/min => accelerating
      w5: okWindow(0, 9000),
      w15: okWindow(0, 4000, 15),
      session: okWindow(0, 4000, 15),
      underlyingChangePct: 0.6, priceConfirms: true, flowPressure: 0.5,
    });
    expect(m.state).toBe("BULLISH_MOMENTUM_STRENGTHENING");
    expect(m.agreement).toBe("ALIGNED");
  });

  it("returns INSUFFICIENT_DATA when windows are unavailable", () => {
    const empty = { label: "w", windowMs: 0, status: "COLLECTING" as const, reason: "collecting", baselineAt: null, currentAt: null, actualSpanMs: null, rows: [] };
    const m = classifyOiMomentum({ w5: empty, w15: empty, session: empty, underlyingChangePct: null, priceConfirms: null, flowPressure: null });
    expect(m.state).toBe("INSUFFICIENT_DATA");
  });
});

describe("OI-derived zones", () => {
  const totals = [
    { strike: 24900, ceOi: 1_000, peOi: 90_000 },
    { strike: 25000, ceOi: 2_000, peOi: 50_000 },
    { strike: 25200, ceOi: 80_000, peOi: 3_000 },
    { strike: 25300, ceOi: 40_000, peOi: 1_000 },
  ];
  const w = (rows: { strike: number; ce: number; pe: number }[]) => ({
    label: "w", windowMs: 0, status: "OK" as const, reason: "", baselineAt: BASE, currentAt: BASE,
    actualSpanMs: 0,
    rows: rows.map((r) => ({ strike: r.strike, ceChange: r.ce, peChange: r.pe, ceChangePct: null, peChangePct: null, ceOi: null, peOi: null })),
  });

  it("puts below spot become support candidates, calls above become resistance", () => {
    const z = buildOiZones({
      totals,
      w5: w([{ strike: 24900, ce: 0, pe: 5000 }, { strike: 25200, ce: 5000, pe: 0 }]),
      w15: w([{ strike: 24900, ce: 0, pe: 7000 }, { strike: 25200, ce: 7000, pe: 0 }]),
      session: w([{ strike: 24900, ce: 0, pe: 9000 }, { strike: 25200, ce: 9000, pe: 0 }]),
      spot: 25100, interval: 100,
      timestamps: { current: BASE, baseline5m: BASE, baseline15m: BASE, session: BASE },
    });
    expect(z.primarySupport!.strike).toBeLessThan(25100);
    expect(z.primarySupport!.kind).toBe("SUPPORT");
    expect(z.primaryResistance!.strike).toBeGreaterThan(25100);
    expect(z.primaryResistance!.kind).toBe("RESISTANCE");
    // primary support is the NEAREST significant zone below spot
    expect(z.primarySupport!.strike).toBe(25000);
    // the heavily-built 24900 put strike is classified STRONG/STRENGTHENING
    const deep = z.all.find((x) => x.strike === 24900)!;
    expect(["STRONG", "STRENGTHENING"]).toContain(deep.classification);
  });

  it("every OI zone stays an unconfirmed CANDIDATE", () => {
    const z = buildOiZones({
      totals, w5: w([]), w15: w([]), session: w([]),
      spot: 25100, interval: 100,
      timestamps: { current: BASE, baseline5m: null, baseline15m: null, session: null },
    });
    expect(z.all.length).toBeGreaterThan(0);
    for (const zone of z.all) {
      expect(zone.provenance).toBe("OI_CANDIDATE");
      expect(zone.confirmation).toBe("CANDIDATE");
      expect(zone.invalidation).toBeTruthy();
    }
  });

  it("persistent unwinding near spot flags breakout/breakdown risk", () => {
    const z = buildOiZones({
      totals,
      w5: w([{ strike: 25200, ce: -6000, pe: 0 }]),
      w15: w([{ strike: 25200, ce: -9000, pe: 0 }]),
      session: w([{ strike: 25200, ce: -9000, pe: 0 }]),
      spot: 25150, interval: 100,
      timestamps: { current: BASE, baseline5m: BASE, baseline15m: BASE, session: BASE },
    });
    const zone = z.all.find((x) => x.strike === 25200)!;
    expect(zone.classification).toBe("BREAKOUT_RISK");
  });

  it("returns no zones without a spot reference", () => {
    const z = buildOiZones({ totals, w5: w([]), w15: w([]), session: w([]), spot: null, interval: 100, timestamps: { current: null, baseline5m: null, baseline15m: null, session: null } });
    expect(z.all).toHaveLength(0);
    expect(z.primarySupport).toBeNull();
  });
});
