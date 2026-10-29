/**
 * Market-wide momentum scanner (Part C).
 *
 * Universe: current F&O-eligible equities derived from the live Upstox
 * instrument master (FUTSTK contracts), never a hardcoded list.
 *
 * Metric definitions (documented, rules 10/13):
 *  - changePct = (LTP − prevDayClose) / prevDayClose from quote OHLC.
 *  - rvol (APPROXIMATE): current cumulative session volume divided by the
 *    EXPECTED volume at this time of day: avgDailyVol20 × elapsedFraction
 *    (uniform intraday distribution assumption — disclosed in UI). Never
 *    compares an incomplete candle with a completed one (rule 10).
 *  - turnoverCr = ATP (provider average price, falls back to LTP) × volume.
 *  - atrPct = ATR14 from 60 daily candles / LTP.
 *  - rsVsNifty = changePct(stock) − changePct(NIFTY 50) — relative strength.
 *  - vwapPos uses provider ATP vs LTP as a session-VWAP proxy, labelled.
 *  - Ranking is fully deterministic for identical inputs; reasons recorded.
 *  - Instruments with stale/missing data are excluded with reasons (rule 12).
 */

import { InstrumentMeta, Quote, round4 } from "./types";

export interface Baseline {
  avgVol20: number | null;
  atr14: number | null;
  /** Independent previous close from provider daily candles. */
  prevClose?: number | null;
}

export interface FuturesCtx {
  futKey: string;
  interp: string | null; // e.g. "possible long build-up"
}

export interface FlowConfirmView {
  status: string;
  available: boolean;
  reason: string;
  deltaRatio: number | null;
  cvdSlope: number | null;
  attributionPct: number;
  score: number;
  label: string;
}

/** Explicit momentum taxonomy — "has a score" is NOT "has momentum". */
export type MomentumClass =
  | "CONFIRMED_BULLISH"
  | "CONFIRMED_BEARISH"
  | "BULLISH_CANDIDATE"
  | "BEARISH_CANDIDATE"
  | "WEAK_MOMENTUM"
  | "NO_MOMENTUM"
  | "INSUFFICIENT_DATA";

export interface ScannerRow {
  instrumentKey: string;
  symbol: string;
  ltp: number;
  changePct: number;
  /** Classification + transparent component breakdown. */
  momentum?: {
    classification: MomentumClass;
    direction: 1 | -1 | 0;
    strength: number;        // 0..1 ATR-normalised move magnitude
    participation: number;   // 0..1 from RVOL
    atrMove: number | null;  // change / ATR%
    breakdown: { k: string; v: number }[];
  };
  /** ESTIMATED order-flow confirmation — supplementary evidence only. */
  flow?: FlowConfirmView | null;
  volumeCum: number | null;
  turnoverCr: number | null;
  /** Liquidity tier (configurable bands) — replaces a single hard cutoff. */
  liquidityTier?: "HIGH" | "MODERATE" | "LOW" | "INSUFFICIENT" | "UNKNOWN";
  /** How the price change was derived, and whether it is a real reading. */
  changeBasis?: string;
  changeExact?: boolean;
  rvol: number | null;
  rvolMode: "APPROXIMATE" | "UNAVAILABLE";
  atrPct: number | null;
  rsVsNifty: number | null;
  vwapPos: "ABOVE" | "BELOW" | null;
  futInterp: string | null;
  proximity: string | null; // e.g. "0.35% below resistance 24,955"
  score: number;
  reasons: string[];
  exclusions: string[];
  quality: Quote["quality"];
}

export interface ScannerOutput {
  asOf: number;
  /**
   * EVERY successfully evaluated instrument this cycle (not just the ranked
   * boards). Downstream consumers such as the dominance engine must read
   * this, otherwise they only ever see existing leaders — a circular
   * dependency that caps coverage at the board sizes.
   */
  allRows: ScannerRow[];
  bullish: ScannerRow[];
  bearish: ScannerRow[];
  rvolLeaders: ScannerRow[];
  liquid: ScannerRow[];
  rejected: { symbol: string; reason: string }[];
  universeSize: number;
  notes: string[];
  /** Honest per-cycle accounting (never present a partial scan as complete). */
  coverage: {
    eligible: number;
    refreshed: number;
    stale: number;
    missingData: number;
    evaluated: number;
    flowConfirmed: number;
    flowUnavailable: number;
    qualifying: number;
    lastUpdate: number;
  };
}

/**
 * Resolve percentage change from the previous close, from ONE shared place so
 * the scanner and dominance engine can never disagree.
 *
 * ROOT-CAUSE FIX: the previous implementation used `((ltp - ohlc.close) /
 * ohlc.close)`. In the documented Upstox full-market-quote response
 * `ohlc.close` can equal `last_price` (the day's latest print) rather than the
 * previous session's close, which made every instrument read 0.00% and
 * therefore disqualified the entire universe from momentum ranking.
 *
 * Fallback order (documented, most reliable first):
 *   1. `net_change` — the provider's own change-vs-previous-close field.
 *      previousClose = ltp − net_change, so the percentage is exact.
 *   2. An independent previous close from provider daily candles (baseline).
 *   3. `ohlc.close` — only when it plausibly IS a previous close, i.e. it
 *      differs from LTP. If it equals LTP we cannot tell whether the market is
 *      genuinely flat or the field simply mirrors the last print, so the value
 *      is reported as UNKNOWN rather than asserted as a real 0.00%.
 *
 * A genuine zero is preserved as an explicit `{ pct: 0, exact: true }` only
 * when the provider's own `net_change` says so.
 */
export function resolveChangePct(
  q: { ltp: number | null; netChange: number | null; close: number | null },
  baselinePrevClose: number | null
): { pct: number; exact: boolean; basis: string } {
  // 1. Provider-reported net_change (authoritative)
  if (q.ltp === null || !Number.isFinite(q.ltp) || q.ltp <= 0) {
    return { pct: 0, exact: false, basis: "no valid LTP" };
  }
  if (q.netChange !== null && Number.isFinite(q.netChange)) {
    const prevClose = q.ltp - q.netChange;
    if (prevClose > 0) {
      return {
        pct: round4((q.netChange / prevClose) * 100),
        exact: true,
        basis: "provider net_change vs previous close",
      };
    }
  }
  // 2. Independent previous close from provider daily candles
  if (baselinePrevClose !== null && baselinePrevClose > 0) {
    return {
      pct: round4(((q.ltp - baselinePrevClose) / baselinePrevClose) * 100),
      exact: true,
      basis: "previous close from provider daily-candle baseline",
    };
  }
  // 3. ohlc.close — only when it is distinguishable from LTP
  if (q.close !== null && q.close > 0) {
    if (Math.abs(q.close - q.ltp) > 1e-9) {
      return {
        pct: round4(((q.ltp - q.close) / q.close) * 100),
        exact: true,
        basis: "ohlc.close (differs from LTP, treated as previous close)",
      };
    }
    // Indistinguishable: cannot tell "genuinely flat" from "field mirrors LTP"
    return { pct: 0, exact: false, basis: "ohlc.close equals LTP — change indeterminate" };
  }
  return { pct: 0, exact: false, basis: "no previous-close reference available" };
}

export function buildScanner(args: {
  universe: InstrumentMeta[];
  quotes: Map<string, Quote>;
  baselines: Map<string, Baseline>;
  futInterpByEquity: Map<string, string>; // equity key -> interpretation label
  proximityByEquity: Map<string, string>;
  niftyChangePct: number | null;
  elapsedFraction: number;
  now: number;
  minTurnoverCr: number;
  /** Per-instrument ESTIMATED flow confirmation (supplementary evidence). */
  flowByKey?: Map<string, FlowConfirmView>;
  /** Quote age beyond which an instrument is counted stale and not evaluated. */
  staleMs?: number;
  /** Configurable turnover bands (₹ crore). */
  liquidityTiers?: { high: number; moderate: number; low: number };
}): ScannerOutput {
  const rows: ScannerRow[] = [];
  const rejected: { symbol: string; reason: string }[] = [];
  const staleMs = args.staleMs ?? 60_000;
  let refreshed = 0;
  let staleCount = 0;
  let missingData = 0;
  let flowConfirmed = 0;
  let flowUnavailable = 0;

  for (const eq of args.universe) {
    const q = args.quotes.get(eq.instrumentKey);
    const reasons: string[] = [];
    const exclusions: string[] = [];
    if (!q || q.ltp === null || q.close === null || q.close === 0) {
      missingData++;
      rejected.push({ symbol: eq.tradingSymbol, reason: "no quote / no previous close — excluded rather than estimated" });
      continue;
    }
    const age = args.now - q.localTs;
    if (age > staleMs) {
      staleCount++;
      rejected.push({ symbol: eq.tradingSymbol, reason: `quote stale by ${Math.round(age / 1000)}s — excluded from live momentum` });
      continue;
    }
    refreshed++;
    const base = args.baselines.get(eq.instrumentKey) ?? { avgVol20: null, atr14: null };
    // SHARED change resolver (see resolveChangePct) — never LTP vs ohlc.close alone
    const change = resolveChangePct(q, base.prevClose ?? null);
    const changePct = change.pct;
    const changeExact = change.exact;

    let rvol: number | null = null;
    let rvolMode: ScannerRow["rvolMode"] = "UNAVAILABLE";
    if (q.volumeCum !== null && base.avgVol20 && base.avgVol20 > 0) {
      const expected = base.avgVol20 * Math.max(args.elapsedFraction, 0.02);
      rvol = expected > 0 ? round4(q.volumeCum / expected) : null;
      rvolMode = "APPROXIMATE";
    }

    const priceRef = q.atp ?? q.ltp;
    const turnoverCr = q.volumeCum !== null ? round4((priceRef * q.volumeCum) / 1e7) : null;
    /**
     * LIQUIDITY TIERS replace the old single hard cutoff. A thin stock is
     * still RANKED (so genuine pressure stays visible) but is barred from
     * ACTIONABLE trade qualification downstream.
     */
    const tiers = args.liquidityTiers ?? { high: 200, moderate: 50, low: args.minTurnoverCr };
    const liquidityTier: NonNullable<ScannerRow["liquidityTier"]> =
      turnoverCr === null ? "UNKNOWN"
      : turnoverCr >= tiers.high ? "HIGH"
      : turnoverCr >= tiers.moderate ? "MODERATE"
      : turnoverCr >= tiers.low ? "LOW"
      : "INSUFFICIENT";
    if (liquidityTier === "INSUFFICIENT") {
      exclusions.push(`turnover ${turnoverCr!.toFixed(1)} Cr below the ${tiers.low} Cr actionable-liquidity floor — ranked but not actionable`);
    }
    const atrPct = base.atr14 ? round4((base.atr14 / q.ltp) * 100) : null;
    const rsVsNifty = args.niftyChangePct !== null ? round4(changePct - args.niftyChangePct) : null;
    const vwapPos = q.atp !== null && q.ltp !== null ? (q.ltp >= q.atp ? "ABOVE" : "BELOW") : null;

    /**
     * ---------------------------------------------------------------
     * DIRECTIONAL MOMENTUM MODEL
     *
     * Hard rule: DIRECTION comes only from price. Participation (RVOL,
     * turnover) and confirmation (flow, RS) can only AMPLIFY an existing
     * directional move — they can never create one. The previous formula
     * used `Math.sign(changePct || 1)`, so a stock with ZERO price change
     * and high RVOL scored strongly bullish. That is the false-positive
     * defect this model removes.
     *
     * Thresholds are ATR-normalised so a 1% move in a 0.8%-ATR stock is
     * treated very differently from 1% in a 4%-ATR stock.
     * ---------------------------------------------------------------
     */
    // ATR-normalised move: how many average true ranges has price travelled?
    const atrMove = atrPct && atrPct > 0 ? round4(changePct / atrPct) : null;
    const absChange = Math.abs(changePct);

    // Direction requires a real move: at least 0.25% AND (when ATR is known)
    // at least 0.2 ATR. Below that the stock is directionally neutral.
    const MIN_ABS_MOVE = 0.25;
    const MIN_ATR_MOVE = 0.2;
    const hasDirection =
      absChange >= MIN_ABS_MOVE && (atrMove === null || Math.abs(atrMove) >= MIN_ATR_MOVE);
    const dir: 1 | -1 | 0 = hasDirection ? (changePct > 0 ? 1 : -1) : 0;

    // STRENGTH (0..1): magnitude of the directional move, ATR-normalised when
    // possible, saturating at ~1.5 ATR / 3%.
    const strength = !hasDirection
      ? 0
      : Math.min(1, atrMove !== null ? Math.abs(atrMove) / 1.5 : absChange / 3);

    // PARTICIPATION (0..1): RVOL is a multiplier on conviction, never a
    // direction. Saturates at 3x so one illiquid spike cannot dominate.
    const participation = rvol !== null ? Math.min(1, Math.max(0, (rvol - 1) / 2)) : 0;

    // RELATIVE STRENGTH (-1..1): outperformance vs NIFTY, ATR-normalised.
    const rsNorm =
      rsVsNifty === null ? 0 : Math.max(-1, Math.min(1, rsVsNifty / Math.max(atrPct ?? 1, 0.5)));

    // VWAP-proxy agreement: only counts when it AGREES with the price
    // direction, and is explicitly a proxy (provider ATP, not true VWAP).
    const vwapAgrees = dir !== 0 && vwapPos !== null && ((dir > 0 && vwapPos === "ABOVE") || (dir < 0 && vwapPos === "BELOW"));

    if (!changeExact) reasons.push(`price change indeterminate (${change.basis}) — not treated as directional evidence`);
    if (hasDirection) reasons.push(`directional move ${changePct.toFixed(2)}%${atrMove !== null ? ` (${Math.abs(atrMove).toFixed(2)}× ATR)` : ""}`);
    else reasons.push(`no meaningful direction: ${changePct.toFixed(2)}% move${atrPct ? ` vs ${atrPct.toFixed(2)}% ATR` : ""}`);
    if (rvol !== null && rvol >= 1.5) reasons.push(`approx RVOL ${rvol.toFixed(1)}× (participation, not direction)`);
    if (rsVsNifty !== null && Math.abs(rsVsNifty) >= 0.5) reasons.push(`RS vs NIFTY ${rsVsNifty > 0 ? "+" : ""}${rsVsNifty.toFixed(2)}`);
    if (vwapAgrees) reasons.push(vwapPos === "ABOVE" ? "above session ATP (VWAP proxy) — agrees with direction" : "below session ATP (VWAP proxy) — agrees with direction");

    /**
     * Composite directional score. Every term is multiplied by `dir`, so a
     * directionless stock scores exactly 0 no matter how extreme its volume.
     */
    const coreScore = dir === 0
      ? 0
      : dir * (
          2.5 * strength +            // price move (primary)
          1.2 * strength * participation + // volume CONFIRMING the move
          0.8 * Math.max(0, dir * rsNorm) + // relative strength, same direction only
          (vwapAgrees ? 0.4 : 0)
        );

    /**
     * SUPPLEMENTARY order-flow confirmation.
     * - Contributes at most ±1.0 and only when attribution coverage is good.
     * - When unavailable it contributes exactly 0: a stock is never penalised
     *   for lacking flow coverage, and is never labelled "flow confirmed".
     */
    const flow = args.flowByKey?.get(eq.instrumentKey) ?? null;
    let flowScore = 0;
    if (flow?.available) {
      flowConfirmed++;
      flowScore = flow.score;
      reasons.push(flow.label);
    } else {
      flowUnavailable++;
      if (flow) reasons.push(`flow unavailable: ${flow.reason}`);
    }
    const score = round4(coreScore + flowScore);

    /**
     * CLASSIFICATION — multi-condition, not a score threshold.
     *  CONFIRMED_*  : real directional move + participation + (RS or flow)
     *  *_CANDIDATE  : real directional move, confirmation still missing
     *  WEAK_MOMENTUM: directional but small / unsupported
     *  NO_MOMENTUM  : no meaningful directional move (high RVOL alone lands here)
     */
    const confirmCount =
      (participation >= 0.25 ? 1 : 0) +
      (dir !== 0 && dir * rsNorm >= 0.25 ? 1 : 0) +
      (flow?.available && dir !== 0 && Math.sign(flow.score) === dir ? 1 : 0) +
      (vwapAgrees ? 1 : 0);

    let classification: MomentumClass;
    if (dir === 0) {
      classification = "NO_MOMENTUM";
    } else if (strength >= 0.35 && confirmCount >= 2) {
      classification = dir > 0 ? "CONFIRMED_BULLISH" : "CONFIRMED_BEARISH";
    } else if (strength >= 0.2 && confirmCount >= 1) {
      classification = dir > 0 ? "BULLISH_CANDIDATE" : "BEARISH_CANDIDATE";
    } else {
      classification = "WEAK_MOMENTUM";
    }
    if (classification === "NO_MOMENTUM") {
      exclusions.push(
        rvol !== null && rvol >= 2
          ? `high RVOL ${rvol.toFixed(1)}× but no meaningful directional move — participation is not momentum`
          : "no meaningful directional price movement"
      );
    }

    const momentumBreakdown: { k: string; v: number }[] = [
      { k: "directional move (ATR-normalised)", v: round4(dir * 2.5 * strength) },
      { k: "volume confirming the move", v: round4(dir * 1.2 * strength * participation) },
      { k: "relative strength vs NIFTY", v: round4(dir === 0 ? 0 : 0.8 * Math.max(0, dir * rsNorm)) },
      { k: "VWAP-proxy agreement", v: vwapAgrees ? round4(dir * 0.4) : 0 },
      { k: "estimated flow confirmation", v: round4(flowScore) },
    ];

    rows.push({
      flow,
      changeBasis: change.basis,
      changeExact: changeExact,
      liquidityTier,
      momentum: {
        classification,
        direction: dir,
        strength: round4(strength),
        participation: round4(participation),
        atrMove,
        breakdown: momentumBreakdown,
      },
      instrumentKey: eq.instrumentKey,
      symbol: eq.tradingSymbol,
      ltp: q.ltp,
      changePct,
      volumeCum: q.volumeCum,
      turnoverCr,
      rvol,
      rvolMode,
      atrPct,
      rsVsNifty,
      vwapPos,
      futInterp: args.futInterpByEquity.get(eq.instrumentKey) ?? null,
      proximity: args.proximityByEquity.get(eq.instrumentKey) ?? null,
      score,
      reasons,
      exclusions,
      quality: q.quality,
    });
  }

  const liquidityOk = rows.filter((r) => r.exclusions.every((e) => e.startsWith("high RVOL") || e.startsWith("no meaningful")) && r.quality !== "STALE");
  const eligible = rows.filter((r) => r.exclusions.length === 0 && r.quality !== "STALE");
  const byScore = (a: ScannerRow, b: ScannerRow) => b.score - a.score || a.symbol.localeCompare(b.symbol);

  /**
   * MOMENTUM LEADERS: only genuinely directional stocks. A positive score is
   * necessary but NOT sufficient — the classification must be a confirmed
   * move or an explicit candidate. This is what stops high-RVOL/flat stocks
   * from appearing as momentum leaders.
   */
  const isMomentum = (r: ScannerRow, up: boolean) => {
    const c = r.momentum?.classification;
    if (!c) return false;
    return up
      ? c === "CONFIRMED_BULLISH" || c === "BULLISH_CANDIDATE"
      : c === "CONFIRMED_BEARISH" || c === "BEARISH_CANDIDATE";
  };
  // confirmed setups rank above candidates, then by score magnitude
  const rank = (a: ScannerRow, b: ScannerRow, up: boolean) => {
    const ca = a.momentum?.classification.startsWith("CONFIRMED") ? 1 : 0;
    const cb = b.momentum?.classification.startsWith("CONFIRMED") ? 1 : 0;
    if (ca !== cb) return cb - ca;
    return up ? byScore(a, b) : a.score - b.score || a.symbol.localeCompare(b.symbol);
  };

  const bullish = eligible.filter((r) => isMomentum(r, true)).sort((a, b) => rank(a, b, true)).slice(0, 12);
  const bearish = eligible.filter((r) => isMomentum(r, false)).sort((a, b) => rank(a, b, false)).slice(0, 12);
  // RVOL / liquidity boards are PARTICIPATION rankings — deliberately
  // independent of direction, and labelled as such in the UI.
  const rvolLeaders = liquidityOk.filter((r) => r.rvol !== null).sort((a, b) => (b.rvol as number) - (a.rvol as number) || a.symbol.localeCompare(b.symbol)).slice(0, 12);
  const liquid = liquidityOk.filter((r) => r.turnoverCr !== null).sort((a, b) => (b.turnoverCr as number) - (a.turnoverCr as number)).slice(0, 12);

  const qualifying = bullish.length + bearish.length;
  return {
    asOf: args.now,
    allRows: rows, // full evaluated universe for downstream consumers
    bullish, bearish, rvolLeaders, liquid,
    rejected: rejected.slice(0, 10),
    universeSize: args.universe.length,
    coverage: {
      eligible: args.universe.length,
      refreshed,
      stale: staleCount,
      missingData,
      evaluated: rows.length,
      flowConfirmed,
      flowUnavailable,
      qualifying,
      lastUpdate: args.now,
    },
    notes: [
      "RVOL is APPROXIMATE: compares cumulative session volume with avgDailyVol × session-elapsed fraction (uniform distribution assumption).",
      "Order-flow confirmation is ESTIMATED from REST snapshots and is supplementary only; instruments without flow coverage are never penalised or labelled flow-confirmed.",
      "Strong momentum directly below major resistance is flagged via proximity — not automatically a good fresh entry.",
      "Ranking is deterministic for identical inputs; scores are not win probabilities.",
      refreshed < args.universe.length
        ? `PARTIAL SCAN: ${refreshed}/${args.universe.length} instruments had fresh quotes this cycle (${staleCount} stale, ${missingData} missing).`
        : `Full-universe scan: all ${refreshed} eligible instruments had fresh quotes.`,
    ],
  };
}
