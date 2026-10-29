/**
 * Approximate Volume Profile engine (Part E).
 *
 * Method (APPROXIMATE — never presented as exact):
 *  - Input: closed session candles that carry per-bar VOLUME.
 *  - Bins are tick-aligned; each candle's volume is allocated across the bins
 *    overlapping [low, high] with a TRIANGULAR weight centered on the typical
 *    price (H+L+C)/3 — a documented approximation, not a uniform smear and
 *    not fake trade prints.
 *  - POC = highest-volume bin center. Value area: expand from POC to cover
 *    VALUE_AREA (70%) of total volume. HVN/LVN = contiguous node centers with
 *    volume > 1.5x / < 0.5x the mean of non-empty bins.
 *  - Zero-volume instruments (pure index candles) return mode UNAVAILABLE
 *    with an explicit note (rule 10 — nothing fabricated).
 */

import { Candle, CalcMode, alignToTick, round4 } from "./types";

export interface ProfileResult {
  mode: CalcMode;
  poc: number | null;
  vah: number | null;
  val: number | null;
  hvn: number[];
  lvn: number[];
  binSize: number;
  bins: { p: number; v: number }[];
  totalVolume: number;
  note: string;
}

const VALUE_AREA = 0.7;
const TARGET_BINS = 48;

export function computeProfile(candles: Candle[], tickSize: number): ProfileResult | null {
  const closed = candles.filter((c) => c.closed && c.v > 0);
  const noteApprox =
    "Approximate candle-based profile: volume allocated across each candle's [low, high] with triangular weighting at the typical price (H+L+C)/3. Not trade-derived.";
  if (closed.length < 10) {
    return {
      mode: "UNAVAILABLE",
      poc: null, vah: null, val: null, hvn: [], lvn: [],
      binSize: 0, bins: [], totalVolume: 0,
      note: "Volume profile unavailable — insufficient volume-bearing bars (index candles carry no volume).",
    };
  }
  let hh = -Infinity;
  let ll = Infinity;
  let totalV = 0;
  for (const c of closed) {
    hh = Math.max(hh, c.h);
    ll = Math.min(ll, c.l);
    totalV += c.v;
  }
  if (!(hh > ll) || totalV <= 0) return null;

  const tick = tickSize > 0 ? tickSize : 0.05;
  const binSize = Math.max(tick, alignToTick((hh - ll) / TARGET_BINS, tick));
  const first = alignToTick(Math.floor(ll / binSize) * binSize, tick);
  const count = Math.max(1, Math.ceil((hh - first) / binSize) + 1);
  const vols = new Array<number>(count).fill(0);

  for (const c of closed) {
    const tp = (c.h + c.l + c.c) / 3;
    const i0 = Math.max(0, Math.floor((c.l - first) / binSize));
    const i1 = Math.min(count - 1, Math.floor((c.h - first) / binSize));
    const span = Math.max(c.h - c.l, binSize);
    const half = span / 2;
    const weights: number[] = [];
    let wSum = 0;
    for (let i = i0; i <= i1; i++) {
      const center = first + (i + 0.5) * binSize;
      const w = Math.max(0, 1 - Math.abs(center - tp) / (half + binSize));
      weights.push(w);
      wSum += w;
    }
    if (wSum <= 0) {
      vols[i0] += c.v;
      continue;
    }
    for (let k = 0; k < weights.length; k++) {
      vols[i0 + k] += (c.v * weights[k]) / wSum;
    }
  }

  // POC
  let pocIdx = 0;
  for (let i = 0; i < count; i++) if (vols[i] > vols[pocIdx]) pocIdx = i;
  const price = (i: number) => round4(first + (i + 0.5) * binSize);

  // Value area: two-sided expansion from POC
  let lo = pocIdx;
  let hi = pocIdx;
  let covered = vols[pocIdx];
  const target = totalV * VALUE_AREA;
  while (covered < target && (lo > 0 || hi < count - 1)) {
    const up = hi < count - 1 ? vols[hi + 1] : -1;
    const down = lo > 0 ? vols[lo - 1] : -1;
    if (up >= down && hi < count - 1) {
      hi++;
      covered += vols[hi];
    } else if (lo > 0) {
      lo--;
      covered += vols[lo];
    } else break;
  }

  // Nodes
  const nonEmpty = vols.filter((v) => v > 0);
  const mean = nonEmpty.reduce((a, b) => a + b, 0) / Math.max(nonEmpty.length, 1);
  const hvn: number[] = [];
  const lvn: number[] = [];
  const collect = (pred: (v: number) => boolean, acc: number[]) => {
    let run: { sum: number; wsum: number } | null = null;
    for (let i = 0; i < count; i++) {
      if (pred(vols[i])) {
        if (!run) run = { sum: 0, wsum: 0 };
        run.sum += vols[i];
        run.wsum += vols[i] * price(i);
      } else if (run) {
        acc.push(round4(run.wsum / run.sum));
        run = null;
      }
    }
    if (run) acc.push(round4(run.wsum / run.sum));
  };
  collect((v) => v > 1.5 * mean, hvn);
  collect((v) => v > 0 && v < 0.5 * mean, lvn);

  return {
    mode: "APPROXIMATE",
    poc: price(pocIdx),
    vah: round4(first + (hi + 1) * binSize),
    val: round4(first + lo * binSize),
    hvn,
    lvn,
    binSize,
    bins: vols.map((v, i) => ({ p: price(i), v: Math.round(v) })),
    totalVolume: totalV,
    note: noteApprox,
  };
}
