/**
 * Candle utilities — session-aware resampling and validation.
 *
 * Conventions:
 *  - Provider 1-minute candles are the only intraday input (exchange IST
 *    timestamps, per-bar non-cumulative volume).
 *  - Resampling anchors buckets to 09:15 IST session open, so 2/5/10-minute
 *    bars never straddle session boundaries.
 *  - The currently-forming bar is flagged closed=false and is excluded from
 *    all signal math; it may be displayed for context.
 *  - Missing intervals are NOT filled with fabricated values (rule 10); a gap
 *    list is returned for transparency.
 */

import {
  Candle,
  istDateKey,
  istMinutesOfDay,
  sessionOpenTs,
  SESSION_LENGTH_MIN,
} from "./types";

/**
 * Keep only bars inside the trading session. Spot/equity coverage is
 * 09:15–15:30 IST; F&O contracts stream closing bars up to 15:40 IST
 * (observed in provider data), so bars opening before 15:40 are kept.
 * Weekday filtering is implicit in provider data (no weekend candles).
 */
export function inSession(c: Candle[]): Candle[] {
  return c.filter((k) => {
    const m = istMinutesOfDay(k.t);
    return m >= 9 * 60 + 15 && m < 15 * 60 + 40;
  });
}

export function dedupeSort(c: Candle[]): Candle[] {
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const k of [...c].sort((a, b) => a.t - b.t)) {
    if (seen.has(k.t)) continue;
    seen.add(k.t);
    out.push(k);
  }
  return out;
}

/** Flag bars that are still forming at `now`. */
export function markClosed(c: Candle[], tfMin: number, now = Date.now()): Candle[] {
  const tfMs = tfMin * 60_000;
  return c.map((k) => ({ ...k, closed: k.t + tfMs <= now }));
}

/** IST-session-anchored resample from 1-minute candles. */
export function resample(oneMin: Candle[], tfMin: number, now = Date.now()): Candle[] {
  if (tfMin === 1) return markClosed(oneMin, 1, now);
  const tfMs = tfMin * 60_000;
  const buckets = new Map<number, Candle>();
  for (const k of oneMin) {
    const anchor = sessionOpenTs(istDateKey(k.t));
    const idx = Math.floor((k.t - anchor) / tfMs);
    if (idx < 0 || idx * tfMin >= SESSION_LENGTH_MIN) continue;
    const b0 = anchor + idx * tfMs;
    const cur = buckets.get(b0);
    if (!cur) {
      buckets.set(b0, { t: b0, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, oi: k.oi, closed: true });
    } else {
      cur.h = Math.max(cur.h, k.h);
      cur.l = Math.min(cur.l, k.l);
      cur.c = k.c;
      cur.v += k.v; // per-bar volumes — correct summation, no double counting
      if (k.oi !== undefined) cur.oi = k.oi;
    }
  }
  return markClosed([...buckets.values()].sort((a, b) => a.t - b.t), tfMin, now);
}

/** Split candles by session date (IST). */
export function bySession(c: Candle[]): Map<string, Candle[]> {
  const m = new Map<string, Candle[]>();
  for (const k of c) {
    const d = istDateKey(k.t);
    const arr = m.get(d) ?? [];
    arr.push(k);
    m.set(d, arr);
  }
  return m;
}

/** List session bars (as epoch starts) that are missing between first/last candle. */
export function gapReport(c: Candle[], tfMin: number): number[] {
  const gaps: number[] = [];
  const tfMs = tfMin * 60_000;
  for (let i = 1; i < c.length; i++) {
    const diff = c[i].t - c[i - 1].t;
    if (diff > tfMs && istDateKey(c[i].t) === istDateKey(c[i - 1].t)) {
      for (let t = c[i - 1].t + tfMs; t < c[i].t; t += tfMs) gaps.push(t);
    }
  }
  return gaps;
}

/** Typical price (H+L+C)/3 — used by VWAP and the approximate volume profile. */
export function typicalPrice(k: Candle): number {
  return (k.h + k.l + k.c) / 3;
}

export function lastClosed(c: Candle[]): Candle | null {
  for (let i = c.length - 1; i >= 0; i--) if (c[i].closed) return c[i];
  return null;
}

export function previousSession(c: Candle[], sessionDate: string): Candle[] {
  const dates = [...bySession(c).keys()].sort();
  const idx = dates.indexOf(sessionDate);
  if (idx <= 0) return [];
  return bySession(c).get(dates[idx - 1]) ?? [];
}
