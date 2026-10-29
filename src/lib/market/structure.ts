/**
 * Price-structure engine (rule 13).
 *
 *  - Pivots: fractal pivots with RIGHT_BARS right-side confirmation bars.
 *    A pivot at bar i is only emitted once bar (i + RIGHT_BARS) has CLOSED —
 *    confirmedAt timestamps the earliest moment the pivot was knowable in
 *    real time. Signals consuming these pivots therefore never use
 *    information that would not have existed historically (no look-ahead).
 *  - Swing labels HH/HL/LH/LL assigned in causal (confirmation) order.
 *  - BOS: close beyond the most recently confirmed same-direction pivot;
 *    CHoCH: close beyond the most recent confirmed counter-trend pivot,
 *    defined as a structural event with explicit level + timestamps.
 *  - Consolidation: bounded range over a lookback relative to ATR.
 */

import { Candle, StructureEvent, RangeInfo, round4 } from "./types";
import { atrSeries, lastOf } from "./indicators";

export const RIGHT_BARS = 3;

interface Swing {
  kind: "H" | "L";
  idx: number;
  price: number;
  confirmedAt: number;
}

export interface StructureResult {
  events: StructureEvent[];
  swings: { type: "PIVOT_HIGH" | "PIVOT_LOW"; price: number; t: number; confirmedAt: number; label: "HH" | "HL" | "LH" | "LL" }[];
  trend: "UP" | "DOWN" | "NEUTRAL";
  range: RangeInfo | null;
}

export function analyzeStructure(candles: Candle[]): StructureResult {
  const closed = candles.filter((c) => c.closed);
  const n = closed.length;
  const events: StructureEvent[] = [];
  const swings: StructureResult["swings"] = [];
  const lastBreakRef: Record<string, number> = {}; // scoped per-instrument call
  if (n < RIGHT_BARS * 2 + 10) return { events, swings, trend: "NEUTRAL", range: null };

  // causal pass: deliver pivots when confirmable, then break checks per bar
  const pending: Swing[] = [];
  const confirmed: Swing[] = [];
  let lastPH: Swing | null = null;
  let lastPL: Swing | null = null;
  let prevPH: Swing | null = null;
  let prevPL: Swing | null = null;
  let trend: "UP" | "DOWN" | "NEUTRAL" = "NEUTRAL";

  for (let j = 0; j < n; j++) {
    const pi = j - RIGHT_BARS;
    if (pi >= RIGHT_BARS) {
      // check bars pi for pivot (all comparison bars now closed)
      const h = closed[pi].h;
      const l = closed[pi].l;
      let isPH = true;
      let isPL = true;
      for (let k2 = pi - RIGHT_BARS; k2 <= pi + RIGHT_BARS; k2++) {
        if (k2 === pi) continue;
        if (closed[k2].h >= h) isPH = false;
        if (closed[k2].l <= l) isPL = false;
        if (!isPH && !isPL) break;
      }
      const confirmedAt = closed[pi + RIGHT_BARS].t;
      if (isPH) {
        const sw: Swing = { kind: "H", idx: pi, price: h, confirmedAt };
        pending.push(sw);
        confirmed.push(sw);
        const label = lastPH ? (h > lastPH.price ? "HH" : "LH") : undefined;
        swings.push({ type: "PIVOT_HIGH", price: h, t: closed[pi].t, confirmedAt, label: label ?? "LH" });
        events.push({ type: "PIVOT_HIGH", level: h, t: closed[pi].t, confirmedAt, label: label ?? undefined });
        prevPH = lastPH;
        lastPH = sw;
      }
      if (isPL) {
        const sw: Swing = { kind: "L", idx: pi, price: l, confirmedAt };
        pending.push(sw);
        confirmed.push(sw);
        const label = lastPL ? (l < lastPL.price ? "LL" : "HL") : undefined;
        swings.push({ type: "PIVOT_LOW", price: l, t: closed[pi].t, confirmedAt, label: label ?? "HL" });
        events.push({ type: "PIVOT_LOW", level: l, t: closed[pi].t, confirmedAt, label: label ?? undefined });
        prevPL = lastPL;
        lastPL = sw;
      }
    }

    // break checks against pivots confirmed strictly BEFORE this bar closes
    const c = closed[j].c;
    if (lastPH && lastPH.idx < j && c > lastPH.price) {
      const type = trend === "DOWN" ? "CHOCH_UP" : "BOS_UP";
      if (lastBreakRef[type] !== lastPH.idx) {
        events.push({ type: type as StructureEventType2, level: lastPH.price, t: closed[j].t, confirmedAt: closed[j].t });
        lastBreakRef[type] = lastPH.idx;
      }
      trend = "UP";
      lastPH = null; // consumed; wait for a new confirmed pivot
    }
    if (lastPL && lastPL.idx < j && c < lastPL.price) {
      const type = trend === "UP" ? "CHOCH_DOWN" : "BOS_DOWN";
      if (lastBreakRef[type] !== lastPL.idx) {
        events.push({ type: type as StructureEventType2, level: lastPL.price, t: closed[j].t, confirmedAt: closed[j].t });
        lastBreakRef[type] = lastPL.idx;
      }
      trend = "DOWN";
      lastPL = null;
    }
    void prevPH;
    void prevPL;
  }

  // consolidation range over recent closed bars
  const atrArr = atrSeries(closed, 14);
  const atr = lastOf(atrArr) ?? 0;
  let range: RangeInfo | null = null;
  const L = Math.min(48, n);
  if (L >= 24 && atr > 0) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let i = n - L; i < n; i++) {
      hh = Math.max(hh, closed[i].h);
      ll = Math.min(ll, closed[i].l);
    }
    const width = hh - ll;
    const active = width <= atr * 6;
    range = { active, low: round4(ll), high: round4(hh), sinceT: closed[n - L].t, bars: L };
  }

  return { events: events.slice(-120), swings: swings.slice(-60), trend, range };
}

type StructureEventType2 = "BOS_UP" | "BOS_DOWN" | "CHOCH_UP" | "CHOCH_DOWN";
