/**
 * Order-flow intelligence (Part G) — capability-gated.
 *
 * Upstox REST quote packets provide LTP and cumulative session volume, but NO
 * executed-trade sequence, NO trade ids, and NO aggressor-side flags.
 * Therefore:
 *  - EXACT Delta/CVD/footprint: UNAVAILABLE (never fabricated).
 *  - ESTIMATED Delta: tick-rule over POLL-LEVEL increments — price up with
 *    positive volume increment => estimated aggressive buy; price down =>
 *    estimated aggressive sell; unchanged price => carry last sign; volume
 *    increments with unchanged price are split by last sign; a session
 *    volume reset (cum < prev) is treated as new session, not fabrication.
 *  - CVD: session-reset (09:15 IST) running sum of estimated deltas. Mid-day
 *    engine boots produce a PARTIAL CVD labelled with the actual start time.
 *  - Footprint: estimated per-price buy/sell aggregation per bar at observed
 *    LTP levels. Diagonal imbalance: buy[i] vs sell[i-1] (ask vs lower bid)
 *    with ratio >= 3 and minimum volume 300; otherwise row is not flagged.
 *  - Absorption/exhaustion/trapped-trader scenarios are emitted as
 *    rule-based EVIDENCE with confidence and required confirmations —
 *    never as trader-intent facts (rule 22-23).
 * Memory: ticks are kept in a per-session ring buffer in process memory; no
 * tick history is persisted (documented: replay unavailable on this surface).
 */

import { FlowTick, FlowBar, FlowAttribution, istDateKey, istMinutesOfDay, sessionOpenTs, round4 } from "./types";

const MAX_TICKS_PER_SESSION = 6000;

/** Polling gap beyond which an increment cannot be attributed by tick rule. */
const MAX_TRUSTED_GAP_MS = 90_000;

export class FlowTracker {
  private ticks: FlowTick[] = [];
  private prevPrice: number | null = null;
  private prevVol: number | null = null;
  private prevTs: number | null = null;
  private sessionDate = "";
  /** First valid cumulative-volume observation — a BASELINE, never traded volume. */
  private baselineVol: number | null = null;
  private baselineAt: number | null = null;
  private observations = 0;
  private attributedVol = 0;
  private unknownVol = 0;
  private resets = 0;
  private gapsSkipped = 0;
  /** How many increments each classification method resolved (transparency). */
  private quoteRuleCount = 0;
  private tickRuleCount = 0;
  /** true once the first observation of the session was recorded */
  bootedAt: number | null = null;

  /**
   * Ingest one REST quote snapshot.
   *
   * CRITICAL ACCOUNTING RULE: the first cumulative-volume observation of a
   * session (or after a reset) establishes a BASELINE and contributes ZERO
   * traded volume. Attributing the whole session's cumulative volume to a
   * single poll would massively corrupt Delta/CVD — especially when the
   * tracker boots mid-session.
   *
   * CLASSIFICATION LADDER (all ESTIMATED — see limitations below):
   *   1. QUOTE RULE (preferred, used when a contemporaneous bid/ask snapshot
   *      is present): LTP at/near the ASK  => buyer-initiated
   *                   LTP at/near the BID  => seller-initiated
   *      "near" = within 25% of the spread of that side's price.
   *   2. TICK RULE (fallback for trades inside the spread): uptick => BUY,
   *      downtick => SELL.
   *   3. UNKNOWN: unchanged price with no quote context, mid-spread with no
   *      prior price, a volume reset, or a polling gap > 90s.
   *
   * LIMITATIONS (never obscured): the bid/ask used is the snapshot captured
   * with the poll, not the quote prevailing at each individual trade, and the
   * volume increment aggregates every trade between two polls. This is an
   * ESTIMATE of aggressor side — not exchange-reported trade classification.
   * Depth QUANTITIES are never used to derive executed volume; only bid/ask
   * PRICES are used to classify, and volume always comes from the
   * cumulative-volume increment.
   */
  onQuote(
    price: number | null,
    volumeCum: number | null,
    localTs: number,
    quote?: { bid: number | null; ask: number | null }
  ): void {
    if (price === null || !Number.isFinite(price) || price <= 0) return;

    // --- session rollover: hard reset of all accounting
    const date = istDateKey(localTs);
    if (date !== this.sessionDate) {
      this.sessionDate = date;
      this.ticks = [];
      this.prevPrice = null;
      this.prevVol = null;
      this.prevTs = null;
      this.baselineVol = null;
      this.baselineAt = null;
      this.observations = 0;
      this.attributedVol = 0;
      this.unknownVol = 0;
      this.bootedAt = null;
    }
    if (this.bootedAt === null) this.bootedAt = localTs;
    this.observations++;

    let volDelta = 0;
    let attributable = true;

    if (volumeCum !== null && Number.isFinite(volumeCum) && volumeCum >= 0) {
      if (this.prevVol === null) {
        // FIRST OBSERVATION → baseline only, zero traded volume recorded
        this.baselineVol = volumeCum;
        this.baselineAt = localTs;
        volDelta = 0;
        attributable = false;
      } else if (volumeCum < this.prevVol) {
        // cumulative volume went backwards → feed reset / contract rollover.
        // Re-establish the baseline instead of emitting a bogus increment.
        this.resets++;
        this.baselineVol = volumeCum;
        this.baselineAt = localTs;
        volDelta = 0;
        attributable = false;
      } else {
        volDelta = volumeCum - this.prevVol;
      }
    }

    // A long polling gap means unobserved trading happened between snapshots:
    // the increment is real volume but its direction cannot be trusted.
    const gap = this.prevTs === null ? 0 : localTs - this.prevTs;
    if (gap > MAX_TRUSTED_GAP_MS && volDelta > 0) {
      this.gapsSkipped++;
      attributable = false;
    }

    let side: FlowTick["side"] = "UNKNOWN";
    let method: "QUOTE_RULE" | "TICK_RULE" | "NONE" = "NONE";
    if (attributable) {
      const bid = quote?.bid ?? null;
      const ask = quote?.ask ?? null;
      const spreadOk = bid !== null && ask !== null && ask > bid && ask - bid > 0;
      if (spreadOk) {
        // 1. QUOTE RULE — classify against the contemporaneous bid/ask prices
        const tol = (ask - bid) * 0.25;
        if (price >= ask - tol) {
          side = "BUY";
          method = "QUOTE_RULE";
        } else if (price <= bid + tol) {
          side = "SELL";
          method = "QUOTE_RULE";
        }
      }
      if (side === "UNKNOWN" && this.prevPrice !== null) {
        // 2. TICK RULE — fallback for mid-spread trades / no quote context
        if (price > this.prevPrice) {
          side = "BUY";
          method = "TICK_RULE";
        } else if (price < this.prevPrice) {
          side = "SELL";
          method = "TICK_RULE";
        }
      }
      // 3. otherwise UNKNOWN — never guessed
    }
    if (method === "QUOTE_RULE") this.quoteRuleCount++;
    else if (method === "TICK_RULE") this.tickRuleCount++;

    if (volDelta > 0) {
      if (side === "UNKNOWN") this.unknownVol += volDelta;
      else this.attributedVol += volDelta;
      this.ticks.push({ t: localTs, price, volDelta, side });
      if (this.ticks.length > MAX_TICKS_PER_SESSION) {
        this.ticks.splice(0, this.ticks.length - MAX_TICKS_PER_SESSION);
      }
    }

    this.prevPrice = price;
    this.prevTs = localTs;
    if (volumeCum !== null && Number.isFinite(volumeCum) && volumeCum >= 0) this.prevVol = volumeCum;
  }

  get tickCount(): number {
    return this.ticks.length;
  }

  /** Honest attribution accounting for the UI and the scanner gate. */
  attribution(): FlowAttribution {
    const totalVol = this.attributedVol + this.unknownVol;
    const partial = this.bootedAt !== null && istMinutesOfDay(this.bootedAt) > 9 * 60 + 16;
    return {
      observations: this.observations,
      attributedVol: Math.round(this.attributedVol),
      unknownVol: Math.round(this.unknownVol),
      totalVol: Math.round(totalVol),
      coveragePct: totalVol > 0 ? round4((this.attributedVol / totalVol) * 100) : 0,
      baselineVol: this.baselineVol,
      baselineAt: this.baselineAt,
      resets: this.resets,
      gapsSkipped: this.gapsSkipped,
      lastObsAt: this.prevTs,
      partialSession: partial,
      quoteRuleCount: this.quoteRuleCount,
      tickRuleCount: this.tickRuleCount,
    };
  }

  /** Aggregate ticks into per-bar ESTIMATED flow with session-reset CVD. */
  bars(barMin = 5): FlowBar[] {
    const map = new Map<number, FlowBar>();
    const anchor = sessionOpenTs(this.sessionDate || istDateKey(Date.now()));
    const barMs = barMin * 60_000;
    let cvd = 0;
    const sorted = [...this.ticks].sort((a, b) => a.t - b.t);
    for (const tk of sorted) {
      const b0 = anchor + Math.floor((tk.t - anchor) / barMs) * barMs;
      let bar = map.get(b0);
      if (!bar) {
        bar = { t: b0, buyVol: 0, sellVol: 0, untracedVol: 0, delta: 0, cvd: 0, perPrice: {} };
        map.set(b0, bar);
      }
      const key = tk.price.toFixed(2);
      const cell = (bar.perPrice[key] = bar.perPrice[key] ?? { buy: 0, sell: 0 });
      if (tk.side === "BUY") {
        bar.buyVol += tk.volDelta;
        cell.buy += tk.volDelta;
      } else if (tk.side === "SELL") {
        bar.sellVol += tk.volDelta;
        cell.sell += tk.volDelta;
      } else {
        // UNKNOWN attribution: conserved and reported, never forced to a side
        bar.untracedVol += tk.volDelta;
      }
      bar.delta = bar.buyVol - bar.sellVol;
      cvd += tk.side === "BUY" ? tk.volDelta : tk.side === "SELL" ? -tk.volDelta : 0;
      bar.cvd = round4(cvd);
    }
    return [...map.values()].sort((a, b) => a.t - b.t);
  }

  /** Reset-policy label for UI honesty. */
  resetLabel(): string {
    if (!this.bootedAt) return "session reset 09:15 IST — no observations yet";
    const d = new Date(this.bootedAt + 5.5 * 3600_000);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const a = this.attribution();
    const partial = a.partialSession;
    return [
      `session reset 09:15 IST`,
      partial ? `PARTIAL: first observation ${hh}:${mm} IST (mid-session start — baseline excluded)` : null,
      `ESTIMATED tick-rule (REST-polled, not exchange order flow)`,
      `attribution ${a.coveragePct.toFixed(0)}% of observed volume`,
      a.resets > 0 ? `${a.resets} volume reset(s) re-baselined` : null,
    ].filter(Boolean).join(" — ");
  }
}

export interface FootprintRow {
  price: number;
  buy: number;
  sell: number;
  delta: number;
  imbalance: "BUY_IMBAL" | "SELL_IMBAL" | null; // diagonal comparison
}

export function footprintRows(bar: FlowBar, minVol = 300, ratio = 3): FootprintRow[] {
  const rows: FootprintRow[] = Object.entries(bar.perPrice)
    .map(([p, v]) => ({ price: Number(p), buy: v.buy, sell: v.sell, delta: v.buy - v.sell, imbalance: null }))
    .sort((a, b) => b.price - a.price);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const lower = rows[i + 1]; // diagonal: ask/buy at p vs bid/sell at p-tick
    const upper = rows[i - 1];
    if (lower && r.buy >= minVol && lower.sell > 0 && r.buy / lower.sell >= ratio) r.imbalance = "BUY_IMBAL";
    if (upper && r.sell >= minVol && upper.buy > 0 && r.sell / upper.buy >= ratio) r.imbalance = "SELL_IMBAL";
  }
  return rows;
}

export interface FlowContext {
  barDelta: number | null;
  recentDeltaSum: number | null;
  cvdNow: number | null;
  cvdSlope: number | null; // per-bar slope over lookback
  divergence: { detected: boolean; bearish: boolean; note: string } | null;
  absorption: { side: "BULL" | "BEAR"; confidence: number; note: string } | null;
}

/**
 * Estimated order-flow context for the signal engine. All numbers are
 * ESTIMATED (tick-rule on poll increments) and null when no data exists.
 */
export function flowContext(bars: FlowBar[], lookback = 6): FlowContext {
  if (bars.length === 0) return { barDelta: null, recentDeltaSum: null, cvdNow: null, cvdSlope: null, divergence: null, absorption: null };
  const last = bars[bars.length - 1];
  const win = bars.slice(-lookback);
  const recentDeltaSum = win.reduce((a, b) => a + b.delta, 0);
  const cvdNow = last.cvd;
  // least-squares slope over window cvd
  let cvdSlope: number | null = null;
  if (win.length >= 4) {
    const xs = win.map((_, i) => i);
    const ys = win.map((b) => b.cvd);
    const xm = xs.reduce((a, b) => a + b, 0) / xs.length;
    const ym = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - xm) * (ys[i] - ym);
      den += (xs[i] - xm) ** 2;
    }
    cvdSlope = den > 0 ? round4(num / den) : null;
  }
  return { barDelta: last.delta, recentDeltaSum, cvdNow, cvdSlope, divergence: null, absorption: null };
}

// ------------------------------------------------------ CVD momentum engine

/** Explicit momentum states driven by Delta/CVD + price agreement. */
export type CvdMomentumState =
  | "STRONG_BULLISH"
  | "BULLISH"
  | "WEAKENING_BULLISH"
  | "NEUTRAL"
  | "WEAKENING_BEARISH"
  | "BEARISH"
  | "STRONG_BEARISH"
  | "INSUFFICIENT_DATA";

export interface CvdMomentum {
  state: CvdMomentumState;
  /** -1..1 directional pressure (normalised; comparable across instruments). */
  pressure: number;
  /** Delta of the most recent bar. */
  lastDelta: number | null;
  /** Delta as % of CLASSIFIED volume over the window (-100..100). */
  normalizedDelta: number | null;
  /** Change in per-bar delta across the window (accel > 0 = building). */
  deltaAcceleration: number | null;
  /** Share of recent bars whose delta agrees with the dominant side (0..1). */
  deltaConsistency: number | null;
  /** Delta as a share of TOTAL observed volume incl. unclassified (-1..1). */
  deltaVsTotalVolume: number | null;
  cvdNow: number | null;
  cvdSlope: number | null;
  cvdAcceleration: number | null;
  /** Price change over the same window, for agreement checks. */
  priceChangeInWindow: number | null;
  priceAgrees: boolean;
  divergence: { detected: boolean; bearish: boolean; note: string } | null;
  /** CVD reset policy + estimation status, shown verbatim in the UI. */
  basis: string;
  reasons: string[];
  mode: "ESTIMATED" | "UNAVAILABLE";
  /**
   * PROVENANCE: which instrument actually supplied the volume. Spot indices
   * report no traded volume, so their flow is proxied from the nearest
   * non-expired index-futures contract. Every consumer must surface this so a
   * futures-derived series is never presented as spot flow.
   */
  sourceKey?: string;
  sourceType?: "SPOT_INDEX" | "INDEX_FUTURE" | "EQUITY" | "FUTURE";
  sourceLabel?: string | null;
  isProxy?: boolean;
  proxyReason?: string;
}

const MIN_MOMENTUM_BARS = 4;

function slope(ys: number[]): number | null {
  const n = ys.length;
  if (n < 3) return null;
  const xm = (n - 1) / 2;
  const ym = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (ys[i] - ym);
    den += (i - xm) ** 2;
  }
  return den > 0 ? round4(num / den) : null;
}

/**
 * Classify Delta/CVD momentum.
 *
 * A positive CVD alone NEVER yields a bullish state: price direction over the
 * same window must agree, otherwise the state is downgraded to WEAKENING_* or
 * flagged as a divergence candidate. All inputs are ESTIMATED (REST-derived).
 */
export function cvdMomentum(
  bars: FlowBar[],
  attribution: FlowAttribution | null,
  closes: number[],
  lookback = 8
): CvdMomentum {
  const empty: CvdMomentum = {
    state: "INSUFFICIENT_DATA",
    pressure: 0,
    lastDelta: null, normalizedDelta: null, deltaAcceleration: null,
    deltaConsistency: null, deltaVsTotalVolume: null,
    cvdNow: null, cvdSlope: null, cvdAcceleration: null,
    priceChangeInWindow: null, priceAgrees: false, divergence: null,
    basis: "session CVD, reset 09:15 IST — ESTIMATED (REST snapshots)",
    reasons: ["not enough order-flow observations"],
    mode: "UNAVAILABLE",
    sourceKey: undefined,
    sourceType: undefined,
    sourceLabel: null,
    isProxy: false,
    proxyReason: "no volume-bearing source resolved",
  };
  if (!attribution || bars.length < MIN_MOMENTUM_BARS) return empty;

  const win = bars.slice(-lookback);
  const reasons: string[] = [];

  const lastDelta = win[win.length - 1].delta;
  const classified = win.reduce((a, b) => a + b.buyVol + b.sellVol, 0);
  const totalVol = win.reduce((a, b) => a + b.buyVol + b.sellVol + b.untracedVol, 0);
  const deltaSum = win.reduce((a, b) => a + b.delta, 0);
  if (classified <= 0) return { ...empty, reasons: ["no classified volume in the window"] };

  const normalizedDelta = round4((deltaSum / classified) * 100);
  const deltaVsTotalVolume = totalVol > 0 ? round4(deltaSum / totalVol) : null;

  // acceleration: slope of per-bar delta (is pressure building or fading?)
  const deltaAcceleration = slope(win.map((b) => b.delta));
  // consistency: share of bars agreeing with the dominant side
  const dom = Math.sign(deltaSum);
  const agreeing = dom === 0 ? 0 : win.filter((b) => Math.sign(b.delta) === dom).length;
  const deltaConsistency = round4(agreeing / win.length);

  const cvdSeries = win.map((b) => b.cvd);
  const cvdNow = cvdSeries[cvdSeries.length - 1];
  const cvdSlope = slope(cvdSeries);
  // acceleration = slope of the second half minus slope of the first half
  const half = Math.floor(cvdSeries.length / 2);
  const s1 = slope(cvdSeries.slice(0, half));
  const s2 = slope(cvdSeries.slice(half));
  const cvdAcceleration = s1 !== null && s2 !== null ? round4(s2 - s1) : null;

  // price over the same window
  const pw = closes.slice(-win.length);
  const priceChangeInWindow = pw.length >= 2 ? round4(pw[pw.length - 1] - pw[0]) : null;
  const flowDir = Math.sign(normalizedDelta);
  const priceDir = priceChangeInWindow === null ? 0 : Math.sign(priceChangeInWindow);
  const priceAgrees = flowDir !== 0 && priceDir === flowDir;

  const divergence = closes.length >= 12 ? detectCvdDivergence(bars, closes) : null;

  // ---- pressure: normalised, bounded, and discounted by attribution quality
  const attribQuality = Math.min(1, attribution.coveragePct / 60);
  let pressure = (normalizedDelta / 100) * attribQuality;
  if (cvdSlope !== null && Math.sign(cvdSlope) === flowDir) pressure *= 1.15; // agreeing CVD trend
  if (!priceAgrees) pressure *= 0.5; // flow without price agreement is weaker evidence
  pressure = round4(Math.max(-1, Math.min(1, pressure)));

  reasons.push(`normalised delta ${normalizedDelta.toFixed(0)}% of classified volume`);
  reasons.push(cvdSlope === null ? "CVD slope unavailable" : `CVD slope ${cvdSlope > 0 ? "rising" : cvdSlope < 0 ? "falling" : "flat"}`);
  reasons.push(`delta consistency ${(deltaConsistency * 100).toFixed(0)}% of bars`);
  if (!priceAgrees && flowDir !== 0) reasons.push("price has NOT confirmed the flow direction over this window");
  if (deltaAcceleration !== null) reasons.push(`delta ${deltaAcceleration > 0 ? "building" : deltaAcceleration < 0 ? "fading" : "flat"}`);
  if (attribution.coveragePct < 60) reasons.push(`only ${attribution.coveragePct.toFixed(0)}% of volume could be attributed — evidence discounted`);

  // ---- state machine (multi-factor; CVD sign alone is never sufficient)
  const strongMag = Math.abs(pressure) >= 0.45 && deltaConsistency >= 0.6;
  const normalMag = Math.abs(pressure) >= 0.2;
  // Fading means pressure is actively DECAYING against the dominant side.
  // A flat delta slope is steady pressure, not weakness, so only a strictly
  // opposite-signed acceleration counts.
  const fading =
    deltaAcceleration !== null && flowDir !== 0 && Math.sign(deltaAcceleration) === -flowDir;

  let state: CvdMomentumState;
  if (flowDir === 0 || Math.abs(pressure) < 0.08) {
    state = "NEUTRAL";
  } else if (flowDir > 0) {
    state = !priceAgrees || fading
      ? "WEAKENING_BULLISH"
      : strongMag ? "STRONG_BULLISH" : normalMag ? "BULLISH" : "WEAKENING_BULLISH";
  } else {
    state = !priceAgrees || fading
      ? "WEAKENING_BEARISH"
      : strongMag ? "STRONG_BEARISH" : normalMag ? "BEARISH" : "WEAKENING_BEARISH";
  }

  return {
    state,
    pressure,
    lastDelta,
    normalizedDelta,
    deltaAcceleration,
    deltaConsistency,
    deltaVsTotalVolume,
    cvdNow,
    cvdSlope,
    cvdAcceleration,
    priceChangeInWindow,
    priceAgrees,
    divergence,
    basis: `session CVD, reset 09:15 IST · ${win.length}-bar window · ESTIMATED (${attribution.quoteRuleCount} quote-rule / ${attribution.tickRuleCount} tick-rule increments)`,
    reasons,
    mode: "ESTIMATED",
  };
}

// -------------------------------------------------- shared flow confirmation

export type FlowConfirmStatus =
  | "UNAVAILABLE"      // no tracker / no observations
  | "INSUFFICIENT"     // too few observations or too little attributable volume
  | "STALE"            // last observation too old to trust
  | "BULLISH"
  | "BEARISH"
  | "NEUTRAL";

export interface FlowConfirmation {
  status: FlowConfirmStatus;
  available: boolean;
  reason: string;
  /** Recent estimated delta normalised by ATTRIBUTABLE volume (-1..1). */
  deltaRatio: number | null;
  cvdSlope: number | null;
  cvdNow: number | null;
  attributionPct: number;
  observations: number;
  divergence: { detected: boolean; bearish: boolean; note: string } | null;
  /**
   * Supplementary score contribution, bounded to ±1.0.
   * ZERO when flow is unavailable — never negative, so a stock is not
   * penalised merely for lacking order-flow coverage.
   */
  score: number;
  label: string;
}

const MIN_FLOW_OBS = 6;
const MIN_ATTRIBUTION_PCT = 20;
const FLOW_STALE_MS = 120_000;

/**
 * The ONE place that converts raw flow into a directional opinion, so the
 * scanner, signal engine and UI all agree and the same underlying volume is
 * never counted twice.
 *
 * Anti-double-counting: the normalised delta ratio is the PRIMARY evidence.
 * CVD slope is correlated with it (same volume stream), so it is used only as
 * a small agreement bonus — never summed as if it were independent evidence.
 */
/**
 * SINGLE flow opinion used by the scanner, Trade Finder and dominance engine.
 *
 * This now DELEGATES to cvdMomentum() so there is exactly one Delta/CVD
 * calculation path in the application. Previously flowConfirmation() and
 * cvdMomentum() computed overlapping values independently, which let the
 * scanner and the dominance tab disagree about the same instrument.
 */
export function flowConfirmation(
  bars: FlowBar[],
  attribution: FlowAttribution | null,
  closes: number[],
  now = Date.now(),
  lookback = 6
): FlowConfirmation {
  const base: FlowConfirmation = {
    status: "UNAVAILABLE",
    available: false,
    reason: "no order-flow observations for this instrument",
    deltaRatio: null,
    cvdSlope: null,
    cvdNow: null,
    attributionPct: attribution?.coveragePct ?? 0,
    observations: attribution?.observations ?? 0,
    divergence: null,
    score: 0,
    label: "flow unavailable",
  };
  if (!attribution || bars.length === 0) return base;
  if (attribution.lastObsAt !== null && now - attribution.lastObsAt > FLOW_STALE_MS) {
    return { ...base, status: "STALE", reason: `last flow observation ${Math.round((now - attribution.lastObsAt) / 1000)}s ago`, label: "flow stale" };
  }
  if (attribution.observations < MIN_FLOW_OBS) {
    return { ...base, status: "INSUFFICIENT", reason: `only ${attribution.observations} observations (need ${MIN_FLOW_OBS})`, label: "collecting flow data" };
  }
  if (attribution.coveragePct < MIN_ATTRIBUTION_PCT) {
    return { ...base, status: "INSUFFICIENT", reason: `only ${attribution.coveragePct.toFixed(0)}% of observed volume could be attributed (need ${MIN_ATTRIBUTION_PCT}%)`, label: "flow attribution too low" };
  }

  /**
   * Derive everything from the ONE CVD momentum engine. `pressure` already
   * encodes normalised delta, CVD-slope agreement, attribution quality and the
   * price-confirmation discount, so the scanner, Trade Finder and dominance
   * tab can no longer disagree about the same instrument.
   */
  const m = cvdMomentum(bars, attribution, closes, Math.max(lookback, 8));
  if (m.mode === "UNAVAILABLE" || m.normalizedDelta === null) {
    return { ...base, status: "INSUFFICIENT", reason: m.reasons[0] ?? "insufficient flow data", label: "collecting flow data" };
  }

  const deltaRatio = round4(m.normalizedDelta / 100);
  const status: FlowConfirmStatus =
    m.state === "STRONG_BULLISH" || m.state === "BULLISH" ? "BULLISH"
    : m.state === "STRONG_BEARISH" || m.state === "BEARISH" ? "BEARISH"
    : "NEUTRAL";

  return {
    status,
    available: true,
    reason: `${m.state.replace(/_/g, " ").toLowerCase()} · ${m.reasons.slice(0, 2).join("; ")}`,
    deltaRatio,
    cvdSlope: m.cvdSlope,
    cvdNow: m.cvdNow,
    attributionPct: attribution.coveragePct,
    observations: attribution.observations,
    divergence: m.divergence,
    // pressure is already bounded -1..1 and price-confirmation-discounted
    score: m.mode === "ESTIMATED" ? round4(Math.max(-1, Math.min(1, m.pressure))) : 0,
    label: `ESTIMATED flow ${status.toLowerCase()} · ${m.state.replace(/_/g, " ").toLowerCase()} (${attribution.coveragePct.toFixed(0)}% attributed)`,
  };
}

/**
 * ESTIMATED CVD divergence vs price over the last two windows — a WARNING,
 * never a standalone entry (rule 23). Caller must demand structure
 * confirmation; it is encoded as pending confirmation.
 */
export function detectCvdDivergence(bars: FlowBar[], closes: number[]): FlowContext["divergence"] {
  const L = Math.min(bars.length, closes.length);
  if (L < 12) return null;
  const b = bars.slice(-L);
  const c = closes.slice(-L);
  const half = Math.floor(L / 2);
  const priceMove = c[L - 1] - c[half - 1];
  const cvdMove = b[L - 1].cvd - b[half - 1].cvd;
  const scale = Math.abs(b[L - 1].cvd) + Math.abs(b[half - 1].cvd) + 1;
  const cvdRel = cvdMove / scale;
  if (priceMove > 0 && cvdRel < -0.15) {
    return { detected: true, bearish: true, note: "ESTIMATED CVD falling while price rises (warning only — requires structure confirmation)" };
  }
  if (priceMove < 0 && cvdRel > 0.15) {
    return { detected: true, bearish: false, note: "ESTIMATED CVD rising while price falls (warning only — requires structure confirmation)" };
  }
  return null;
}
