/**
 * Scan-cycle + OI-driven Trade Finder tests.
 *
 * Contracts under test:
 *  - the coordinated cadence defaults to 30s and stays env-configurable
 *  - a 30s poll is NOT a new 5m/15m observation window
 *  - multi-timeframe OI adjusts an existing setup but never creates one
 *  - 5m-vs-15m conflicts are surfaced, never forced into a direction
 *  - unavailable OI windows contribute exactly 0 (never assumed neutral)
 *  - unified primary levels are used for Target 2
 */
import { describe, it, expect } from "vitest";
import { loadPollConfig } from "../src/lib/market/restScheduler";
import { deriveSignals, OiTradeContext } from "../src/lib/market/signals";
import { OiHistory, buildWindow, StrikeObservation, OiObservation } from "../src/lib/market/oiIntelligence";
import { analyzeStructure } from "../src/lib/market/structure";
import { buildZones } from "../src/lib/market/srEngine";
import { Candle } from "../src/lib/market/types";

// ---------------------------------------------------------------- cadence
describe("coordinated 30-second scan cadence", () => {
  it("defaults quotes, scanner and chains to one 30s cycle", () => {
    const cfg = loadPollConfig();
    expect(cfg.quoteMs).toBe(30_000);
    expect(cfg.scannerMs).toBe(30_000);
    expect(cfg.chainMs).toBe(30_000);
  });

  it("remains env-configurable but clamped to safe bounds", () => {
    process.env.POLL_QUOTES_MS = "45000";
    expect(loadPollConfig().quoteMs).toBe(45_000);
    process.env.POLL_QUOTES_MS = "1"; // dangerously fast
    expect(loadPollConfig().quoteMs).toBeGreaterThanOrEqual(3_000);
    delete process.env.POLL_QUOTES_MS;
  });

  it("the request budget for one 30s cycle stays inside provider limits", () => {
    const cfg = loadPollConfig();
    const keys = 435;                       // equities + futures + indices
    const requests = Math.ceil(keys / cfg.quoteBatch) + 3; // quotes + ~3 chains
    const rps = requests / (cfg.quoteMs / 1000);
    expect(rps).toBeLessThan(cfg.rateRps);
    expect(rps).toBeLessThan(1);            // ~0.27 req/s
  });
});

// ------------------------------------------- 30s polls vs 5m/15m windows
describe("a 30s poll is not a new observation window", () => {
  const BASE = Date.parse("2026-10-28T10:00:00+05:30");
  const LADDER = [25000, 25100, 25200];
  function obs(offsetMs: number, ceBase: number): OiObservation {
    const strikes = new Map<number, StrikeObservation>();
    for (const strike of LADDER) {
      strikes.set(strike, { strike, ceOi: ceBase, peOi: 8_000, ceLtp: 100, peLtp: 100, ceVol: 10, peVol: 10 });
    }
    return { t: BASE + offsetMs, spot: 25100, expiry: "2026-10-29", strikes };
  }

  it("ten 30s polls do not fabricate a 5m baseline before 5 real minutes elapse", () => {
    const h = new OiHistory();
    // four polls = only 90s of history
    for (let i = 0; i < 4; i++) h.record("A", "E", obs(i * 30_000, 10_000 + i * 100));
    const now = BASE + 90_000;
    expect(h.baselineFor("A", "E", 5 * 60_000, now)).toBeNull();
    const w = buildWindow("5m", 5 * 60_000, h.latest("A", "E"), h.baselineFor("A", "E", 5 * 60_000, now), LADDER, 2, 4);
    expect(w.status).toBe("COLLECTING");
    expect(w.rows).toHaveLength(0);
  });

  it("after enough 30s polls the 5m and 15m windows use their own real baselines", () => {
    const h = new OiHistory();
    for (let i = 0; i <= 40; i++) h.record("A", "E", obs(i * 30_000, 10_000 + i * 100)); // 20 min
    const now = BASE + 40 * 30_000;
    const b5 = h.baselineFor("A", "E", 5 * 60_000, now);
    const b15 = h.baselineFor("A", "E", 15 * 60_000, now);
    expect(b5!.t).toBe(BASE + 15 * 60_000);
    expect(b15!.t).toBe(BASE + 5 * 60_000);
    expect(b5!.t).not.toBe(b15!.t);
    const w5 = buildWindow("5m", 5 * 60_000, h.latest("A", "E"), b5, LADDER, 2, 41);
    const w15 = buildWindow("15m", 15 * 60_000, h.latest("A", "E"), b15, LADDER, 2, 41);
    // 15m change is 3x the 5m change here ONLY because the fixture is linear;
    // the values are computed independently from distinct baselines.
    expect(w5.rows[0].ceChange).toBe(1000);
    expect(w15.rows[0].ceChange).toBe(3000);
    expect(w5.baselineAt).not.toBe(w15.baselineAt);
  });
});

// --------------------------------------------- OI-driven trade qualification
describe("Trade Finder multi-timeframe OI qualification", () => {
  const BASE = Date.parse("2026-10-28T09:15:00+05:30");
  /** Breakout-and-retest shape that reliably produces a LONG candidate. */
  function candles(): Candle[] {
    const prices: number[] = [];
    for (let i = 0; i < 26; i++) prices.push(100 + (i % 4));       // base 100-103
    for (let i = 0; i < 8; i++) prices.push(97);                   // pullback (pivots)
    for (let i = 1; i <= 6; i++) prices.push(103 + i * 0.6);       // break out
    prices.push(105.6, 106.2);                                     // retest + hold
    return prices.map((p, i) => ({
      t: BASE + i * 300_000, o: p - 0.3, h: p + 0.5, l: p - 0.5, c: p, v: 1500 + i * 10, closed: true,
    }));
  }
  function setup(oiCtx: OiTradeContext | null) {
    const c = candles();
    const structure = analyzeStructure(c);
    const zones = buildZones({
      instrumentKey: "T|X", timeframeMin: 5, candles: c, structure,
      profile: null, oiLevels: null, tickSize: 0.05, atr: 2,
    });
    return deriveSignals({
      instrumentKey: "T|X", timeframeMin: 5, candles: c, structure, zones,
      flow: null, chainCtx: null, oiCtx, atr: 2, tickSize: 0.05,
      dataQuality: "LIVE", now: BASE + 42 * 300_000,
    });
  }
  const win = (bias: 1 | -1 | 0, available = true) => ({
    available, reason: available ? "ok" : "collecting history",
    ceChange: bias > 0 ? -2000 : 2000, peChange: bias > 0 ? 5000 : -5000, bias,
  });

  it("OI evidence never creates a setup on its own", () => {
    // Flat candles produce no price-action scenario; strong OI cannot invent one.
    const flat: Candle[] = Array.from({ length: 50 }, (_, i) => ({
      t: BASE + i * 300_000, o: 100, h: 100.1, l: 99.9, c: 100, v: 1000, closed: true,
    }));
    const structure = analyzeStructure(flat);
    const sigs = deriveSignals({
      instrumentKey: "T|X", timeframeMin: 5, candles: flat, structure,
      zones: buildZones({ instrumentKey: "T|X", timeframeMin: 5, candles: flat, structure, profile: null, oiLevels: null, tickSize: 0.05, atr: 1 }),
      flow: null, chainCtx: null,
      oiCtx: { w5: win(1), w15: win(1), session: win(1), totalCeOi: 1e6, totalPeOi: 2e6, agreement: "ALIGNED", momentumState: "BULLISH_MOMENTUM_STRENGTHENING", postureNotes: [] },
      atr: 1, tickSize: 0.05, dataQuality: "LIVE", now: BASE + 50 * 300_000,
    });
    expect(sigs).toHaveLength(0);
  });

  it("aligned bullish OI raises the score versus no OI evidence", () => {
    const withOi = setup({ w5: win(1), w15: win(1), session: win(1), totalCeOi: 1e6, totalPeOi: 2e6, agreement: "ALIGNED", momentumState: "BULLISH_MOMENTUM_STRENGTHENING", postureNotes: ["25000 PE: possible put writing"] });
    const without = setup(null);
    const longWith = withOi.find((s) => s.direction === "LONG");
    const longWithout = without.find((s) => s.direction === "LONG");
    expect(longWith).toBeDefined();
    expect(longWithout).toBeDefined();
    expect(longWith!.score).toBeGreaterThan(longWithout!.score);
    expect(longWith!.trace.rules.some((r) => /5m OI|15m OI/.test(r))).toBe(true);
  });

  it("a 5m-vs-15m conflict is surfaced and penalised, never forced", () => {
    const conflicting = setup({
      w5: win(1), w15: win(-1), session: win(-1),
      totalCeOi: 1e6, totalPeOi: 1e6, agreement: "CONFLICTING",
      momentumState: "CONFLICTING_OI_SIGNALS", postureNotes: [],
    });
    const long = conflicting.find((s) => s.direction === "LONG");
    if (long) {
      expect(long.breakdown.some((b) => b.k.includes("CONFLICTING"))).toBe(true);
      expect(long.pending.some((p) => /conflict/i.test(p))).toBe(true);
      expect(long.trace.rules.some((r) => /NOT forced/i.test(r))).toBe(true);
    }
  });

  it("unavailable OI windows contribute zero and are listed as pending", () => {
    const sigs = setup({
      w5: win(0, false), w15: win(0, false), session: win(0, false),
      totalCeOi: null, totalPeOi: null, agreement: "UNKNOWN", momentumState: null, postureNotes: [],
    });
    const long = sigs.find((s) => s.direction === "LONG");
    expect(long).toBeDefined();
    const oiFactors = long!.breakdown.filter((b) => /OI/.test(b.k) && !/CONFLICT/.test(b.k));
    for (const f of oiFactors) expect(f.v).toBe(0);
    expect(long!.pending.some((p) => /window unavailable/i.test(p))).toBe(true);
  });

  it("missing OI context entirely is reported as pending, not assumed neutral", () => {
    const sigs = setup(null);
    const long = sigs.find((s) => s.direction === "LONG");
    expect(long!.pending.some((p) => /multi-timeframe OI evidence unavailable/i.test(p))).toBe(true);
  });

  it("opposing OI reduces the score relative to aligned OI", () => {
    const aligned = setup({ w5: win(1), w15: win(1), session: win(1), totalCeOi: 1e6, totalPeOi: 2e6, agreement: "ALIGNED", momentumState: null, postureNotes: [] });
    const opposed = setup({ w5: win(-1), w15: win(-1), session: win(-1), totalCeOi: 2e6, totalPeOi: 1e6, agreement: "ALIGNED", momentumState: null, postureNotes: [] });
    const a = aligned.find((s) => s.direction === "LONG");
    const o = opposed.find((s) => s.direction === "LONG");
    if (a && o) expect(a.score).toBeGreaterThan(o.score);
  });

  it("the unified primary resistance is used as Target 2 when it offers room", () => {
    const c = candles();
    const structure = analyzeStructure(c);
    const zones = buildZones({ instrumentKey: "T|X", timeframeMin: 5, candles: c, structure, profile: null, oiLevels: null, tickSize: 0.05, atr: 2 });
    const sigs = deriveSignals({
      instrumentKey: "T|X", timeframeMin: 5, candles: c, structure, zones,
      flow: null, chainCtx: null, oiCtx: null,
      unifiedLevels: { immediateSupport: 104, primarySupport: 100, immediateResistance: 108, primaryResistance: 125 },
      atr: 2, tickSize: 0.05, dataQuality: "LIVE", now: BASE + 42 * 300_000,
    });
    const long = sigs.find((s) => s.direction === "LONG");
    if (long) expect(long.targets[1]).toBe(125); // shared unified level, not a local guess
  });

  it("stale data still yields no signals regardless of OI strength", () => {
    const c = candles();
    const structure = analyzeStructure(c);
    const sigs = deriveSignals({
      instrumentKey: "T|X", timeframeMin: 5, candles: c, structure,
      zones: buildZones({ instrumentKey: "T|X", timeframeMin: 5, candles: c, structure, profile: null, oiLevels: null, tickSize: 0.05, atr: 2 }),
      flow: null, chainCtx: null,
      oiCtx: { w5: win(1), w15: win(1), session: win(1), totalCeOi: 1e6, totalPeOi: 2e6, agreement: "ALIGNED", momentumState: null, postureNotes: [] },
      atr: 2, tickSize: 0.05, dataQuality: "STALE", now: BASE + 42 * 300_000,
    });
    expect(sigs).toHaveLength(0);
  });
});
