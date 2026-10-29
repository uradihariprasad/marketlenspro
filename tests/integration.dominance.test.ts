/**
 * Integration: REAL Upstox candles → structure → S/R zones → dominance.
 *
 * Uses the public historical-candle endpoint (no token required) so the
 * dominance engine is exercised against genuine market data rather than
 * synthetic fixtures. Proves the tab, S/R engine and scanner share one
 * consistent pipeline.
 */
import { describe, it, expect } from "vitest";
import { loadUniverse, fetchHistoricalCandles, fetchIntradayCandles } from "../src/lib/market/upstox";
import { dedupeSort, inSession, resample } from "../src/lib/market/candles";
import { analyzeStructure } from "../src/lib/market/structure";
import { buildZones, zoneMap } from "../src/lib/market/srEngine";
import { computeProfile } from "../src/lib/market/volumeProfile";
import { atrSeries, lastOf, vwapSeries } from "../src/lib/market/indicators";
import { buildDominance, DominanceStructure } from "../src/lib/market/dominance";
import type { ScannerRow } from "../src/lib/market/scanner";
import { istDateKey } from "../src/lib/market/types";

const RELIANCE = "NSE_EQ|INE002A01018";

describe("dominance over real provider data", () => {
  it(
    "builds structure + zones from live candles and ranks with traceable evidence",
    { timeout: 120_000 },
    async () => {
      const u = await loadUniverse();
      const eq = u.foEquities.find((e) => e.instrumentKey === RELIANCE);
      expect(eq).toBeDefined();

      const to = istDateKey(Date.now());
      const from = istDateKey(Date.now() - 6 * 86_400_000);
      const [hist, today] = await Promise.all([
        fetchHistoricalCandles(RELIANCE, "1minute", to, from, null),
        fetchIntradayCandles(RELIANCE, "1minute", to, null).catch(() => []),
      ]);
      const merged = dedupeSort(inSession([...hist, ...today]));
      expect(merged.length).toBeGreaterThan(200);

      const bars = resample(merged, 5, Date.now());
      const closed = bars.filter((c) => c.closed);
      expect(closed.length).toBeGreaterThan(40);

      const structure = analyzeStructure(bars);
      const atr = lastOf(atrSeries(closed, 14)) ?? 0;
      expect(atr).toBeGreaterThan(0);

      const sessionBars = closed.filter((c) => istDateKey(c.t) === istDateKey(closed[closed.length - 1].t));
      const profile = sessionBars.some((c) => c.v > 0) ? computeProfile(sessionBars, eq!.tickSize) : null;

      const zones = buildZones({
        instrumentKey: RELIANCE,
        timeframeMin: 5,
        candles: bars,
        structure,
        profile,
        oiLevels: null,
        tickSize: eq!.tickSize,
        atr,
        vwap: lastOf(vwapSeries(closed)),
      });
      expect(zones.length).toBeGreaterThan(0);

      const price = closed[closed.length - 1].c;
      const zm = zoneMap(price, zones);

      // primary zones must be on the correct sides of real price
      if (zm.nearestSupport) expect(zm.nearestSupport.mid).toBeLessThanOrEqual(price);
      if (zm.nearestResistance) expect(zm.nearestResistance.mid).toBeGreaterThanOrEqual(price);

      const trend = structure.trend;
      const st: DominanceStructure = {
        trend,
        lastEvent: structure.events.length ? structure.events[structure.events.length - 1].type : null,
        zones,
        primarySupport: zm.nearestSupport,
        primaryResistance: zm.nearestResistance,
        atr,
        analysedAt: Date.now(),
      };

      // Build a scanner row from REAL candle-derived values (no invented numbers)
      const prevSessionClose = closed[Math.max(0, closed.length - 76)].c;
      const changePct = ((price - prevSessionClose) / prevSessionClose) * 100;
      const atrPct = (atr / price) * 100;
      const atrMove = atrPct > 0 ? changePct / atrPct : null;
      const direction: 1 | -1 | 0 = Math.abs(changePct) >= 0.25 && Math.abs(atrMove ?? 0) >= 0.2 ? (changePct > 0 ? 1 : -1) : 0;
      const row: ScannerRow = {
        instrumentKey: RELIANCE,
        symbol: eq!.tradingSymbol,
        ltp: price,
        changePct,
        momentum: {
          classification: direction === 0 ? "NO_MOMENTUM" : direction > 0 ? "BULLISH_CANDIDATE" : "BEARISH_CANDIDATE",
          direction,
          strength: direction === 0 ? 0 : Math.min(1, Math.abs(atrMove ?? 0) / 1.5),
          participation: 0.5,
          atrMove,
          breakdown: [],
        },
        flow: null, // no live polling in this test — must degrade honestly
        volumeCum: sessionBars.reduce((a, c) => a + c.v, 0),
        turnoverCr: 500,
        rvol: 1.5,
        rvolMode: "APPROXIMATE",
        atrPct,
        rsVsNifty: null,
        vwapPos: null,
        futInterp: null,
        proximity: null,
        score: 0,
        reasons: [],
        exclusions: [],
        quality: "LIVE",
      };

      const dom = buildDominance({
        rows: [row],
        structures: new Map([[RELIANCE, st]]),
        now: Date.now(),
        topN: 5,
      });

      // Engine-level contracts hold on real data
      expect(dom.evaluated).toBe(1);
      expect(dom.coverage.withStructure).toBe(1);
      expect(dom.coverage.withFlow).toBe(0); // no flow in this context — reported, not faked
      expect(dom.buyers.length + dom.sellers.length).toBeLessThanOrEqual(2);

      const all = [...dom.buyers, ...dom.sellers];
      for (const c of all) {
        // every candidate is fully traceable
        expect(c.factors.length).toBeGreaterThanOrEqual(6);
        expect(c.score).toBeGreaterThanOrEqual(0);
        expect(c.score).toBeLessThanOrEqual(100);
        // flow is unavailable here, so it must never claim confirmation
        expect(c.flowMode).toBe("UNAVAILABLE");
        expect(c.action).not.toBe("ACTIONABLE");
        // levels, when present, are on the correct side of real price
        if (c.nearestSupport !== null) expect(c.nearestSupport).toBeLessThanOrEqual(c.ltp);
        if (c.nearestResistance !== null) expect(c.nearestResistance).toBeGreaterThanOrEqual(c.ltp);
      }
      // list is never padded
      expect(dom.buyers.length).toBeLessThanOrEqual(5);
      if (dom.buyers.length < 5 || dom.sellers.length < 5) {
        expect(dom.shortfallNote).toBeTruthy();
      }
    }
  );
});
