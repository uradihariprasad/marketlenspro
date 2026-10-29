/**
 * Indicator engine — deterministic formulas, explicit warm-up, session resets.
 *
 *  - EMA: SMA-seeded after `n` observations; nulls before warm-up.
 *  - RSI: Wilder smoothing (n=14).
 *  - MACD: EMA12-EMA26, signal EMA9.
 *  - ATR: Wilder (n=14) over true range.
 *  - VWAP: session reset (IST date boundary), typical-price × volume; returns
 *    nulls for zero-volume instruments (indices) rather than fabricated.
 *  - All functions ignore non-closed bars policy at call-site; they operate on
 *    provided arrays only.
 */

import { Candle, istDateKey, round4 } from "./types";

export function emaSeries(values: (number | null)[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let seed = 0;
  let count = 0;
  let ema: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) continue;
    if (ema === null) {
      seed += v;
      count++;
      if (count === n) {
        ema = seed / n;
        out[i] = round4(ema);
      }
    } else {
      ema = v * k + ema * (1 - k);
      out[i] = round4(ema);
    }
  }
  return out;
}

export function rsiSeries(closes: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / n;
  let avgL = loss / n;
  out[n] = avgL === 0 ? 100 : round4(100 - 100 / (1 + avgG / avgL));
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (n - 1) + Math.max(d, 0)) / n;
    avgL = (avgL * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = avgL === 0 ? 100 : round4(100 - 100 / (1 + avgG / avgL));
  }
  return out;
}

export function macdSeries(closes: number[], fast = 12, slow = 26, sig = 9) {
  const f = emaSeries(closes, fast);
  const s = emaSeries(closes, slow);
  const macd: (number | null)[] = closes.map((_, i) =>
    f[i] !== null && s[i] !== null ? round4((f[i] as number) - (s[i] as number)) : null
  );
  const signal = emaSeries(macd, sig);
  const hist: (number | null)[] = macd.map((m, i) =>
    m !== null && signal[i] !== null ? round4(m - (signal[i] as number)) : null
  );
  return { macd, signal, hist };
}

export function atrSeries(c: Candle[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(c.length).fill(null);
  if (c.length <= n) return out;
  const trs: number[] = [0];
  for (let i = 1; i < c.length; i++) {
    trs.push(
      Math.max(
        c[i].h - c[i].l,
        Math.abs(c[i].h - c[i - 1].c),
        Math.abs(c[i].l - c[i - 1].c)
      )
    );
  }
  let atr = 0;
  for (let i = 1; i <= n; i++) atr += trs[i];
  atr /= n;
  out[n] = round4(atr);
  for (let i = n + 1; i < c.length; i++) {
    atr = (atr * (n - 1) + trs[i]) / n;
    out[i] = round4(atr);
  }
  return out;
}

/** Session-reset VWAP. Returns null when the instrument has no volume. */
export function vwapSeries(c: Candle[]): (number | null)[] {
  const out: (number | null)[] = new Array(c.length).fill(null);
  let cumPV = 0;
  let cumV = 0;
  let day = "";
  for (let i = 0; i < c.length; i++) {
    const d = istDateKey(c[i].t);
    if (d !== day) {
      day = d;
      cumPV = 0;
      cumV = 0;
    }
    const tp = (c[i].h + c[i].l + c[i].c) / 3;
    cumPV += tp * c[i].v;
    cumV += c[i].v;
    out[i] = cumV > 0 ? round4(cumPV / cumV) : null;
  }
  return out;
}

/** Last non-null convenience. */
export function lastOf(s: (number | null)[]): number | null {
  for (let i = s.length - 1; i >= 0; i--) if (s[i] !== null) return s[i];
  return null;
}
