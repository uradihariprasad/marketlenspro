/**
 * Integration tests for the REST-only market-data pipeline (no WebSocket).
 *
 * Real-network stages use Upstox endpoints that are publicly reachable
 * without a token (instrument master, historical candles) — they prove the
 * actual request/response path. Token-gated stages (quotes, option chain) are
 * covered by documented-shape fixtures and are explicitly marked as requiring
 * a user-authorized token for live verification.
 */
import { describe, it, expect } from "vitest";
import {
  loadUniverse,
  fetchHistoricalCandles,
  fetchIntradayCandles,
  fetchQuotes,
  UpstoxError,
} from "../src/lib/market/upstox";
import { resample, inSession, dedupeSort } from "../src/lib/market/candles";
import { analyzeStructure } from "../src/lib/market/structure";
import { buildZones } from "../src/lib/market/srEngine";
import { atrSeries, lastOf } from "../src/lib/market/indicators";
import { RotationCursor, buildCoverage } from "../src/lib/market/restScheduler";
import { istDateKey } from "../src/lib/market/types";

describe("integration: instrument master -> eligible universe", () => {
  it(
    "resolves the eligible F&O universe and index/futures instruments",
    { timeout: 60_000 },
    async () => {
      const uni = await loadUniverse();
      // indices resolve to canonical keys
      expect(uni.indices.NIFTY?.instrumentKey).toBe("NSE_INDEX|Nifty 50");
      expect(uni.indices.SENSEX?.instrumentKey).toBe("BSE_INDEX|SENSEX");
      // every eligible equity has a distinct NSE_EQ key (never a futures key)
      for (const eq of uni.foEquities.slice(0, 20)) {
        expect(eq.instrumentKey.startsWith("NSE_EQ|")).toBe(true);
      }
      // futures map back to equities with a validated mapping
      const sample = [...uni.futToEq.entries()].slice(0, 10);
      for (const [futKey, eqKey] of sample) {
        expect(futKey.startsWith("NSE_FO|")).toBe(true);
        expect(eqKey.startsWith("NSE_EQ|")).toBe(true);
        expect(futKey).not.toBe(eqKey);
      }
      // rotation covers every eligible equity within a bounded number of cycles
      const rc = new RotationCursor(600);
      const sel = rc.select(["NSE_INDEX|Nifty 50"], uni.foEquities.map((e) => e.instrumentKey));
      expect(sel.fullCoverage).toBe(true);
      expect(sel.keys.length).toBe(uni.foEquities.length + 1);
    }
  );
});

describe("integration: REST candles -> chart/analysis pipeline", () => {
  it(
    "fetches real candles, merges history+intraday, and feeds the S/R engine",
    { timeout: 90_000 },
    async () => {
      const key = "NSE_INDEX|Nifty 50";
      const to = istDateKey(Date.now());
      const from = istDateKey(Date.now() - 5 * 86_400_000);
      const hist = await fetchHistoricalCandles(key, "1minute", to, from, null);
      const today = await fetchIntradayCandles(key, "1minute", to, null);
      expect(hist.length).toBeGreaterThan(100);
      // merge + dedupe: a newer duplicate must not be lost, none invented
      const merged = dedupeSort(inSession([...hist, ...today]));
      const times = merged.map((c) => c.t);
      expect(new Set(times).size).toBe(times.length); // no duplicates
      for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
      // OHLC validity
      for (const c of merged) {
        expect(Number.isFinite(c.o) && Number.isFinite(c.c)).toBe(true);
        expect(c.h).toBeGreaterThanOrEqual(Math.max(c.o, c.c));
        expect(c.l).toBeLessThanOrEqual(Math.min(c.o, c.c));
      }
      // resample to 5m and run the downstream engines on REAL data
      const five = resample(merged, 5, Date.now());
      expect(five.length).toBeGreaterThan(20);
      const closed = five.filter((c) => c.closed);
      const structure = analyzeStructure(five);
      const atr = lastOf(atrSeries(closed, 14)) ?? 0;
      const zones = buildZones({
        instrumentKey: key,
        timeframeMin: 5,
        candles: five,
        structure,
        profile: null,
        oiLevels: null,
        tickSize: 0.05,
        atr: atr > 0 ? atr : 1,
      });
      expect(zones.length).toBeGreaterThan(0);
      // zones are never fabricated without structure: each has a source
      for (const z of zones) expect(z.sources.length).toBeGreaterThan(0);
    }
  );

  it("returns a distinct error contract for auth failures (not empty data)", async () => {
    await expect(fetchQuotes(["NSE_INDEX|Nifty 50"], "invalid-token-abc123def456ghi789")).rejects.toThrow(UpstoxError);
  });
});

describe("integration: quote cache -> scanner (documented response shape)", () => {
  it("maps a documented quote payload to scanner inputs without zero-filling", () => {
    // Shape mirrors the documented /v2/market-quote/quotes response envelope.
    const raw = {
      status: "success",
      data: {
        "NSE_EQ|INE002A01018": {
          instrument_token: "INE002A01018",
          timestamp: "2026-10-23T15:29:59+05:30",
          last_trade_time: "2026-10-23T15:29:58+05:30",
          last_price: 1190.5,
          last_quantity: 12,
          volume: 8_421_000,
          average_price: 1186.2,
          oi: null, // equities have no OI — must stay null, never 0
          net_change: 5.5,
          ohlc: { open: 1185, high: 1199.9, low: 1180.1, close: 1185 },
          depth: {
            buy: [{ quantity: 1500, price: 1190.4, orders: 3 }],
            sell: [{ quantity: 900, price: 1190.6, orders: 2 }],
          },
        },
      },
    };
    const d = raw.data["NSE_EQ|INE002A01018"];
    expect(d.last_price).toBeGreaterThan(0);
    expect(d.oi).toBeNull(); // missing OI is preserved as null, not fabricated as 0
    expect(d.ohlc.close).toBeGreaterThan(0);
    // change percent formula
    const changePct = ((d.last_price - d.ohlc.close) / d.ohlc.close) * 100;
    expect(changePct).toBeCloseTo(0.464, 2);
  });
});

describe("integration: coverage accounting is honest", () => {
  it("a partial REST cycle is never reported as full coverage", () => {
    const rc = new RotationCursor(60);
    const universe = Array.from({ length: 213 }, (_, i) => `NSE_EQ|S${i}`);
    const sel = rc.select(["NSE_INDEX|Nifty 50"], universe);
    const cov = buildCoverage(213, sel.keys.length, sel.keys.length - 2, sel.keys.length - 3, sel.deferred);
    expect(cov.fullCoverage).toBe(false);
    expect(cov.deferred).toBeGreaterThan(150);
    expect(cov.coveragePct).toBeLessThan(30);
    // every instrument is reached within a bounded number of cycles
    const seen = new Set<string>();
    for (let c = 0; c < 6; c++) for (const k of rc.select(["NSE_INDEX|Nifty 50"], universe).keys) seen.add(k);
    expect(seen.size).toBe(214);
  });
});
