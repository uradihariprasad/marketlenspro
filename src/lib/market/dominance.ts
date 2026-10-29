/**
 * Buyer / Seller Dominance Engine.
 *
 * Ranks instruments by EVIDENCE of buying or selling pressure, combining the
 * existing engines (no duplicated market logic):
 *   - scanner.ts      → price change, RVOL, ATR-normalised move, RS vs NIFTY
 *   - orderflow.ts    → ESTIMATED delta ratio, CVD slope, attribution coverage
 *   - structure.ts    → trend / BOS / CHoCH market structure
 *   - srEngine.ts     → primary support & resistance, zone provenance
 *
 * HONESTY RULES (enforced in code, covered by tests):
 *  1. Dominance is NOT a trade signal. A strong score with a poor entry
 *     location is classified WATCHLIST_ONLY, never ACTIONABLE.
 *  2. Delta/CVD here are ESTIMATED (REST tick-rule). Normalised per-instrument
 *     (delta as a fraction of attributable volume) so raw Delta is never
 *     compared across stocks with different liquidity.
 *  3. Every factor is bounded and contributes a documented, inspectable
 *     amount. Missing evidence contributes 0 — never a negative penalty and
 *     never an assumed value.
 *  4. The engine returns FEWER than N candidates when fewer qualify, and says
 *     why the remaining slots are empty.
 */

import { Zone, round4 } from "./types";
import type { ScannerRow } from "./scanner";

// ------------------------------------------------------------------- types

export type DominanceSide = "BUYER" | "SELLER";

/**
 * Staged statuses. RANKING and TRADE QUALIFICATION are deliberately separate:
 * a stock can be a legitimate dominance candidate (visible on the board)
 * without ever being an actionable trade.
 */
export type DominanceAction =
  | "ACTIONABLE"         // dominance + good entry location + liquidity + confirmation
  | "WATCHLIST_ONLY"     // real dominance, but entry location / liquidity is poor
  | "NEEDS_CONFIRMATION" // dominance present, confirmation evidence missing
  | "RANKED_CANDIDATE"   // ranks on evidence, below the confirmation bar
  | "INSUFFICIENT_DATA"  // minimum data eligibility not met
  | "NOT_QUALIFIED";     // no directional evidence at all

export interface DominanceFactor {
  k: string;
  v: number;            // bounded contribution to the score
  detail: string;
  /** EXACT = computed from provider values; ESTIMATED = tick-rule derived. */
  mode: "EXACT" | "ESTIMATED" | "UNAVAILABLE";
}

export interface ReversalRisk {
  level: "LOW" | "MODERATE" | "HIGH";
  reasons: string[];
}

export interface DominanceCandidate {
  rank: number;
  instrumentKey: string;
  symbol: string;
  side: DominanceSide;
  ltp: number;
  changePct: number;
  /** 0..100 normalised dominance score. NOT a probability of profit. */
  score: number;
  factors: DominanceFactor[];
  // order-flow evidence (ESTIMATED unless a provider field says otherwise)
  deltaRatio: number | null;
  cvdSlope: number | null;
  flowStatus: string;
  flowMode: "EXACT" | "ESTIMATED" | "UNAVAILABLE";
  attributionPct: number;
  /** Shared ESTIMATED CVD momentum state (same object the chart/TF use). */
  cvdState: string;
  normalizedDelta: number | null;
  deltaAcceleration: number | null;
  deltaConsistency: number | null;
  cvdNow: number | null;
  cvdBasis: string | null;
  priceConfirmsFlow: boolean;
  divergence: { detected: boolean; bearish: boolean; note: string } | null;
  // participation
  rvol: number | null;
  rvolMode: string;
  volumeStatus: "EXPANDING" | "NORMAL" | "THIN" | "UNKNOWN";
  turnoverCr: number | null;
  liquidityTier: string;
  /** Price-change provenance, so an indeterminate reading is never mistaken for 0.00%. */
  changeBasis?: string;
  changeExact?: boolean;
  // structure & levels
  trend: "UP" | "DOWN" | "NEUTRAL" | "UNKNOWN";
  structureNote: string;
  nearestSupport: number | null;
  nearestResistance: number | null;
  supportLabel: string | null;
  resistanceLabel: string | null;
  nextTarget: number | null;
  targetRoomPct: number | null;
  reversalRisk: ReversalRisk;
  // qualification
  action: DominanceAction;
  actionReason: string;
  entryLocation: "GOOD" | "EXTENDED" | "INTO_OPPOSING_ZONE" | "UNKNOWN";
  quality: string;
  dataAgeMs: number | null;
  why: string[];
}

export interface DominanceOutput {
  asOf: number;
  buyers: DominanceCandidate[];
  sellers: DominanceCandidate[];
  requested: number;
  evaluated: number;
  qualifiedBuyers: number;
  qualifiedSellers: number;
  /** Explains empty slots instead of padding the list. */
  shortfallNote: string | null;
  coverage: {
    /** Total eligible F&O stocks in the instrument universe. */
    eligibleUniverse: number;
    /** Rows the scanner successfully evaluated this cycle. */
    evaluated: number;
    /** Rows with a valid price + price change (minimum ranking data). */
    withValidPriceVolume: number;
    /** Rows with ENOUGH observations for a usable Delta/CVD estimate. */
    withFlow: number;
    /** Rows with completed market-structure analysis. */
    withStructure: number;
    stale: number;
    insufficientData: number;
    /** % of the eligible universe that was evaluated this cycle. */
    coveragePct: number;
    partial: boolean;
    universe: number; // retained alias
    withQuotes: number;
  };
  settings: { minScore: number; minActionableScore: number; minTurnoverCr: number };
  notes: string[];
}

/** Per-instrument structural context supplied by the engine (already computed). */
export interface DominanceStructure {
  trend: "UP" | "DOWN" | "NEUTRAL";
  lastEvent: string | null;
  zones: Zone[];
  primarySupport: Zone | null;
  primaryResistance: Zone | null;
  atr: number | null;
  analysedAt: number;
}

/** Minimal CVD-momentum view consumed by the dominance scorer. */
export interface CvdMomentumView {
  state: string;
  pressure: number;
  normalizedDelta: number | null;
  deltaAcceleration: number | null;
  deltaConsistency: number | null;
  cvdSlope: number | null;
  cvdNow: number | null;
  priceAgrees: boolean;
  divergence: { detected: boolean; bearish: boolean; note: string } | null;
  basis: string;
  mode: string;
}

export interface DominanceInput {
  rows: ScannerRow[];
  structures: Map<string, DominanceStructure>;
  /** ESTIMATED CVD momentum per instrument (shared with chart/TradeFinder). */
  cvd?: Map<string, CvdMomentumView>;
  /** Total eligible F&O universe size, for honest coverage reporting. */
  eligibleUniverse?: number;
  now: number;
  topN?: number;
  /**
   * Minimum score to APPEAR ON THE LEADERBOARD. Deliberately low: ranking
   * shows the strongest available evidence. Trade qualification is a separate,
   * stricter gate (see `minActionableScore`).
   */
  minScore?: number;
  /** Stricter floor required before a candidate may be ACTIONABLE. */
  minActionableScore?: number;
  /** Turnover (₹ Cr) required for ACTIONABLE status — not for ranking. */
  minTurnoverCr?: number;
  staleMs?: number;
}

// ----------------------------------------------------------------- scoring

const W = {
  directionalMove: 28,   // ATR-normalised price travel in the dominance direction
  flow: 26,              // ESTIMATED delta ratio (normalised per instrument)
  cvdSlope: 12,          // CVD trend agreeing with the side
  participation: 16,     // RVOL confirming the move
  structure: 12,         // market structure agreeing
  relativeStrength: 6,   // vs NIFTY
};
const MAX_SCORE = Object.values(W).reduce((a, b) => a + b, 0); // 100

/**
 * Score one row for one side. All factors are signed by `side`, so evidence
 * pointing the other way can never inflate the score.
 */
function scoreSide(
  row: ScannerRow,
  st: DominanceStructure | undefined,
  side: DominanceSide,
  cvd?: CvdMomentumView
): {
  score: number;
  factors: DominanceFactor[];
  directionalEvidence: boolean;
} {
  const dirSign = side === "BUYER" ? 1 : -1;
  const factors: DominanceFactor[] = [];
  const m = row.momentum;

  /**
   * HARD GATE — directional price evidence is REQUIRED to appear on a
   * dominance board at all.
   *
   * ROOT-CAUSE FIX: previously a stock with NO directional move could still
   * score the full `structure` weight (12/100), and because the ranking floor
   * was 8, every stock whose trend happened to agree was ranked with an
   * identical low score. That is precisely "classifying by market-structure
   * direction alone", which is forbidden. Market structure is now SUPPORTING
   * evidence only and can never create a dominance candidate.
   */
  const aligned = m && m.direction === dirSign;
  const strength = aligned ? m!.strength : 0;
  const directionalEvidence = strength > 0 && (row.changeExact ?? true);
  factors.push({
    k: "directional move",
    v: round4(W.directionalMove * strength),
    detail: aligned
      ? `${row.changePct.toFixed(2)}%${m!.atrMove !== null ? ` (${Math.abs(m!.atrMove).toFixed(2)}× ATR)` : ""} in the ${side === "BUYER" ? "up" : "down"} direction`
      : `no ${side === "BUYER" ? "upward" : "downward"} directional move — cannot be ranked on structure alone`,
    mode: "EXACT",
  });
  if (!directionalEvidence) {
    // No directional price evidence: nothing else may rank this instrument.
    return { score: 0, factors, directionalEvidence: false };
  }

  // 2. ESTIMATED order flow — normalised delta ratio (never raw delta)
  const f = row.flow ?? null;
  if (f?.available && f.deltaRatio !== null) {
    const agree = Math.max(0, dirSign * f.deltaRatio); // 0..1
    // scale by attribution coverage: thin attribution earns less credit
    const credit = agree * Math.min(1, f.attributionPct / 60);
    factors.push({
      k: "estimated delta (normalised)",
      v: round4(W.flow * credit),
      detail: `delta ${(f.deltaRatio * 100).toFixed(0)}% of attributable volume, ${f.attributionPct.toFixed(0)}% attributed`,
      mode: "ESTIMATED",
    });
    /**
     * CVD-trend credit. Uses the shared CVD momentum engine when available
     * (slope + persistence + delta acceleration). Because delta and CVD come
     * from the SAME volume stream, this is deliberately a smaller, capped
     * term — it confirms the delta factor rather than double-counting it.
     * A state whose price has not confirmed the flow earns only half credit.
     */
    let cvdCredit = 0;
    let cvdDetail: string;
    if (cvd && cvd.mode === "ESTIMATED") {
      const slopeAgrees = cvd.cvdSlope !== null && Math.sign(cvd.cvdSlope) === dirSign;
      const stateAgrees = dirSign > 0 ? cvd.state.includes("BULLISH") : cvd.state.includes("BEARISH");
      const persistence = cvd.deltaConsistency ?? 0;
      const accelAgrees = cvd.deltaAcceleration !== null && Math.sign(cvd.deltaAcceleration) === dirSign;
      cvdCredit =
        (slopeAgrees ? 0.5 : 0) + (stateAgrees ? 0.3 * persistence : 0) + (accelAgrees ? 0.2 : 0);
      if (!cvd.priceAgrees) cvdCredit *= 0.5; // flow unconfirmed by price
      cvdDetail = `${cvd.state.replace(/_/g, " ").toLowerCase()} · slope ${cvd.cvdSlope ?? "n/a"} · consistency ${(persistence * 100).toFixed(0)}%${cvd.priceAgrees ? "" : " · price has not confirmed"}`;
    } else {
      const slopeAgree = f.cvdSlope !== null && Math.sign(f.cvdSlope) === dirSign ? 1 : 0;
      cvdCredit = slopeAgree;
      cvdDetail = f.cvdSlope !== null ? `CVD slope ${f.cvdSlope > 0 ? "rising" : "falling"}` : "CVD slope unavailable";
    }
    factors.push({
      k: "CVD trend agreement",
      v: round4(W.cvdSlope * Math.max(0, Math.min(1, cvdCredit)) * Math.min(1, f.attributionPct / 60)),
      detail: cvdDetail,
      mode: "ESTIMATED",
    });
  } else {
    factors.push({ k: "estimated delta (normalised)", v: 0, detail: f?.reason ?? "no order-flow observations", mode: "UNAVAILABLE" });
    factors.push({ k: "CVD trend agreement", v: 0, detail: "unavailable", mode: "UNAVAILABLE" });
  }

  // 3. Participation — only credited when it confirms a real move
  const part = m?.participation ?? 0;
  factors.push({
    k: "volume participation",
    v: round4(W.participation * part * (strength > 0 ? 1 : 0)),
    detail: row.rvol !== null ? `RVOL ${row.rvol.toFixed(1)}× (${row.rvolMode.toLowerCase()})` : "RVOL unavailable",
    mode: row.rvolMode === "APPROXIMATE" ? "ESTIMATED" : "UNAVAILABLE",
  });

  // 4. Market structure agreement — SUPPORTING evidence only (never sufficient)
  const trendAgrees = st ? (side === "BUYER" ? st.trend === "UP" : st.trend === "DOWN") : false;
  factors.push({
    k: "market structure (supporting)",
    v: trendAgrees && directionalEvidence ? W.structure : 0,
    detail: st
      ? `structure ${st.trend}${st.lastEvent ? ` (${st.lastEvent})` : ""}${directionalEvidence ? "" : " — ignored without directional price evidence"}`
      : "structure not yet analysed",
    mode: st ? "EXACT" : "UNAVAILABLE",
  });

  // 5. Relative strength vs NIFTY, direction-gated
  const rs = row.rsVsNifty;
  const rsAgree = rs !== null ? Math.max(0, Math.min(1, (dirSign * rs) / 2)) : 0;
  factors.push({
    k: "relative strength vs NIFTY",
    v: round4(W.relativeStrength * rsAgree),
    detail: rs !== null ? `RS ${rs > 0 ? "+" : ""}${rs.toFixed(2)}` : "RS unavailable",
    mode: rs !== null ? "EXACT" : "UNAVAILABLE",
  });

  const raw = factors.reduce((a, b) => a + b.v, 0);
  return {
    score: round4(Math.max(0, Math.min(100, (raw / MAX_SCORE) * 100))),
    factors,
    directionalEvidence,
  };
}

/** Where is price sitting relative to the zone it is heading into? */
function assessEntry(
  price: number,
  st: DominanceStructure | undefined,
  side: DominanceSide,
  atr: number | null
): { location: DominanceCandidate["entryLocation"]; target: number | null; roomPct: number | null; note: string } {
  if (!st) return { location: "UNKNOWN", target: null, roomPct: null, note: "no structural analysis yet" };
  const ahead = side === "BUYER" ? st.primaryResistance : st.primarySupport;
  if (!ahead) return { location: "UNKNOWN", target: null, roomPct: null, note: "no valid zone ahead of price" };
  const target = ahead.mid;
  const room = Math.abs(target - price);
  const roomPct = round4((room / Math.max(price, 1)) * 100);
  // "Room" is judged in ATR units when ATR is known — a 0.3% gap means very
  // different things for a calm stock and a volatile one.
  const roomAtr = atr && atr > 0 ? room / atr : null;
  if (roomAtr !== null && roomAtr < 0.5) {
    return { location: "INTO_OPPOSING_ZONE", target, roomPct, note: `only ${roomAtr.toFixed(2)}× ATR to ${side === "BUYER" ? "resistance" : "support"} ${target}` };
  }
  if (roomAtr !== null && roomAtr > 4) {
    return { location: "EXTENDED", target, roomPct, note: `price is far (${roomAtr.toFixed(1)}× ATR) from the next zone — chasing risk` };
  }
  return { location: "GOOD", target, roomPct, note: `${roomAtr !== null ? `${roomAtr.toFixed(2)}× ATR` : `${roomPct.toFixed(2)}%`} of room to ${target}` };
}

function assessReversalRisk(
  row: ScannerRow,
  st: DominanceStructure | undefined,
  side: DominanceSide,
  entryLocation: DominanceCandidate["entryLocation"]
): ReversalRisk {
  const reasons: string[] = [];
  let risk = 0;
  if (entryLocation === "INTO_OPPOSING_ZONE") {
    risk += 2;
    reasons.push(`price is pressing directly into ${side === "BUYER" ? "resistance" : "support"}`);
  }
  if (entryLocation === "EXTENDED") {
    risk += 1;
    reasons.push("move is extended from the next reference zone");
  }
  const f = row.flow ?? null;
  if (f?.available && f.deltaRatio !== null) {
    const dirSign = side === "BUYER" ? 1 : -1;
    if (Math.sign(f.deltaRatio) !== dirSign) {
      risk += 2;
      reasons.push("ESTIMATED order flow currently opposes the dominance direction (possible absorption)");
    }
  } else {
    reasons.push("order-flow confirmation unavailable — reversal risk cannot be assessed from flow");
  }
  const trendOpposes = st ? (side === "BUYER" ? st.trend === "DOWN" : st.trend === "UP") : false;
  if (trendOpposes) {
    risk += 2;
    reasons.push("higher-level market structure opposes the move (counter-trend pressure)");
  }
  if (row.quality === "STALE") {
    risk += 1;
    reasons.push("quote is stale");
  }
  return { level: risk >= 4 ? "HIGH" : risk >= 2 ? "MODERATE" : "LOW", reasons };
}

// -------------------------------------------------------------------- main

export function buildDominance(inp: DominanceInput): DominanceOutput {
  const topN = inp.topN ?? 5;
  // Ranking floor is LOW (show the best available evidence); the actionable
  // floor is high. The previous single floor of 45 emptied the whole board.
  const minScore = inp.minScore ?? 8;
  const minActionable = inp.minActionableScore ?? 45;
  const minTurnover = inp.minTurnoverCr ?? 25;
  const staleMs = inp.staleMs ?? 60_000;

  const candidates: DominanceCandidate[] = [];
  let withFlow = 0;
  let withStructure = 0;
  let stale = 0;
  let insufficientData = 0;
  let withValidPriceVolume = 0;

  for (const row of inp.rows) {
    if (row.quality === "STALE") stale++;
    const st = inp.structures.get(row.instrumentKey);
    if (st) withStructure++;
    if (row.flow?.available) withFlow++;

    /**
     * STAGE A — data eligibility. Only the MINIMUM required fields gate
     * ranking: a valid price and a usable price change. Optional indicators
     * (flow, OI, structure, ATR) never disqualify an otherwise valid stock.
     */
    if (!Number.isFinite(row.ltp) || row.ltp <= 0 || !Number.isFinite(row.changePct)) {
      insufficientData++;
      continue;
    }
    withValidPriceVolume++;
    // STAGE B — liquidity TIER (does not exclude from ranking)
    const tier = row.liquidityTier ?? (row.turnoverCr === null ? "UNKNOWN" : row.turnoverCr >= minTurnover ? "MODERATE" : "INSUFFICIENT");
    const liquidityOkForTrade = tier === "HIGH" || tier === "MODERATE" || tier === "LOW";

    for (const side of ["BUYER", "SELLER"] as DominanceSide[]) {
      const cvdView = inp.cvd?.get(row.instrumentKey);
      const { score, factors, directionalEvidence } = scoreSide(row, st, side, cvdView);
      // Structure-only or indeterminate-change instruments are never ranked.
      if (!directionalEvidence) continue;
      if (score <= 0) continue;

      const atr = st?.atr ?? (row.atrPct !== null ? (row.atrPct / 100) * row.ltp : null);
      const entry = assessEntry(row.ltp, st, side, atr);
      const reversalRisk = assessReversalRisk(row, st, side, entry.location);
      const f = row.flow ?? null;

      /**
       * STAGE C — ranking vs trade qualification.
       * `minScore` only controls BOARD VISIBILITY. Everything stricter
       * (liquidity, flow confirmation, entry location, reversal risk) governs
       * whether a visible candidate may ever be called ACTIONABLE.
       */
      let action: DominanceAction;
      let actionReason: string;
      if (score < minScore) {
        action = "NOT_QUALIFIED";
        actionReason = `no meaningful directional evidence (score ${score.toFixed(0)} < ${minScore})`;
      } else if (score < minActionable) {
        action = "RANKED_CANDIDATE";
        actionReason = f?.available
          ? `ranks on available evidence (score ${score.toFixed(0)}) but is below the ${minActionable} actionable bar`
          : `REDUCED CONFIDENCE — ranked on price/volume/structure only (score ${score.toFixed(0)}); Delta/CVD confirmation unavailable, so it cannot be ACTIONABLE`;
      } else if (!liquidityOkForTrade) {
        action = "WATCHLIST_ONLY";
        actionReason = `liquidity tier ${tier} (turnover ${row.turnoverCr?.toFixed(0) ?? "?"} Cr < ${minTurnover} Cr) — ranked but not actionable`;
      } else if (!f?.available) {
        /**
         * Reduced-confidence mode: ranked on price + participation + structure
         * + relative strength only. The missing flow confirmation is stated
         * explicitly so the ranking is never mistaken for flow-confirmed.
         */
        action = "NEEDS_CONFIRMATION";
        actionReason =
          "REDUCED CONFIDENCE — ranked on price/volume/structure/relative-strength only; Delta/CVD confirmation is unavailable, so this cannot be ACTIONABLE";
      } else if (entry.location === "INTO_OPPOSING_ZONE") {
        action = "WATCHLIST_ONLY";
        actionReason = `strong ${side.toLowerCase()} dominance but price is entering an opposing zone — poor entry location`;
      } else if (entry.location === "EXTENDED") {
        action = "WATCHLIST_ONLY";
        actionReason = "move is extended from the next reference zone — wait for a pullback or retest";
      } else if (entry.location === "UNKNOWN") {
        action = "NEEDS_CONFIRMATION";
        actionReason = "no valid zone ahead of price — target and invalidation cannot be framed yet";
      } else if (reversalRisk.level === "HIGH") {
        action = "WATCHLIST_ONLY";
        actionReason = "reversal risk is HIGH — conflicting evidence";
      } else {
        action = "ACTIONABLE";
        actionReason = "dominance, entry location and confirmation all acceptable — verify against the Trade Finder setup";
      }

      const why = factors
        .filter((x) => x.v > 0)
        .sort((a, b) => b.v - a.v)
        .slice(0, 4)
        .map((x) => `${x.k}: ${x.detail}`);

      candidates.push({
        rank: 0,
        instrumentKey: row.instrumentKey,
        symbol: row.symbol,
        side,
        ltp: row.ltp,
        changePct: row.changePct,
        score,
        factors,
        deltaRatio: f?.deltaRatio ?? null,
        cvdSlope: f?.cvdSlope ?? null,
        flowStatus: f?.status ?? "UNAVAILABLE",
        flowMode: f?.available ? "ESTIMATED" : "UNAVAILABLE",
        attributionPct: f?.attributionPct ?? 0,
        cvdState: cvdView?.state ?? "INSUFFICIENT_DATA",
        normalizedDelta: cvdView?.normalizedDelta ?? null,
        deltaAcceleration: cvdView?.deltaAcceleration ?? null,
        deltaConsistency: cvdView?.deltaConsistency ?? null,
        cvdNow: cvdView?.cvdNow ?? null,
        cvdBasis: cvdView?.basis ?? null,
        priceConfirmsFlow: cvdView?.priceAgrees ?? false,
        divergence: cvdView?.divergence ?? null,
        rvol: row.rvol,
        rvolMode: row.rvolMode,
        volumeStatus:
          row.rvol === null ? "UNKNOWN" : row.rvol >= 2 ? "EXPANDING" : row.rvol >= 0.8 ? "NORMAL" : "THIN",
        turnoverCr: row.turnoverCr,
        liquidityTier: tier,
        changeBasis: row.changeBasis,
        changeExact: row.changeExact,
        trend: st?.trend ?? "UNKNOWN",
        structureNote: st?.lastEvent ?? "structure pending analysis",
        nearestSupport: st?.primarySupport?.mid ?? null,
        nearestResistance: st?.primaryResistance?.mid ?? null,
        supportLabel: st?.primarySupport ? `${st.primarySupport.state} · ${st.primarySupport.provenanceGroup}` : null,
        resistanceLabel: st?.primaryResistance ? `${st.primaryResistance.state} · ${st.primaryResistance.provenanceGroup}` : null,
        nextTarget: entry.target,
        targetRoomPct: entry.roomPct,
        reversalRisk,
        action,
        actionReason,
        entryLocation: entry.location,
        quality: row.quality,
        dataAgeMs: null,
        why,
      });
    }
  }

  /**
   * Deterministic ranking. Scores saturate, so genuine ties are common; break
   * them by the magnitude of the actual directional move (the strongest mover
   * ranks first) and only then alphabetically, so ordering is stable and
   * never merely alphabetical.
   */
  const qualified = (side: DominanceSide) =>
    candidates
      .filter((c) => c.side === side && c.action !== "NOT_QUALIFIED")
      .sort(
        (a, b) =>
          b.score - a.score ||
          Math.abs(b.changePct) - Math.abs(a.changePct) ||
          (b.turnoverCr ?? 0) - (a.turnoverCr ?? 0) ||
          a.symbol.localeCompare(b.symbol)
      );

  const buyers = qualified("BUYER").slice(0, topN).map((c, i) => ({ ...c, rank: i + 1 }));
  const sellers = qualified("SELLER").slice(0, topN).map((c, i) => ({ ...c, rank: i + 1 }));

  const shortfalls: string[] = [];
  if (buyers.length < topN) shortfalls.push(`${topN - buyers.length} buyer slot(s) empty`);
  if (sellers.length < topN) shortfalls.push(`${topN - sellers.length} seller slot(s) empty`);

  return {
    asOf: inp.now,
    buyers,
    sellers,
    requested: topN,
    evaluated: inp.rows.length,
    qualifiedBuyers: qualified("BUYER").length,
    qualifiedSellers: qualified("SELLER").length,
    shortfallNote: shortfalls.length
      ? `${shortfalls.join(" and ")} — only ${qualified("BUYER").length} buyer / ${qualified("SELLER").length} seller candidates showed directional evidence (ranking floor ${minScore}). The list is never padded.`
      : null,
    coverage: {
      eligibleUniverse: inp.eligibleUniverse ?? inp.rows.length,
      evaluated: inp.rows.length,
      withValidPriceVolume,
      withFlow,
      withStructure,
      stale,
      insufficientData,
      coveragePct: inp.eligibleUniverse
        ? round4((inp.rows.length / inp.eligibleUniverse) * 100)
        : 100,
      partial: !!inp.eligibleUniverse && inp.rows.length < inp.eligibleUniverse,
      universe: inp.rows.length,
      withQuotes: withValidPriceVolume,
    },
    settings: { minScore, minActionableScore: minActionable, minTurnoverCr: minTurnover },
    notes: [
      "Dominance is EVIDENCE OF PRESSURE, not a trade signal. Statuses: ACTIONABLE / WATCHLIST_ONLY / NEEDS_CONFIRMATION / RANKED_CANDIDATE.",
      "Delta and CVD are ESTIMATED from REST snapshots (quote rule, tick-rule fallback) and normalised per instrument — raw Delta is never compared across stocks.",
      "Scores are bounded 0-100 confluence aggregates. They are NOT calibrated probabilities of profit.",
      `Ranking floor is ${minScore} (board visibility). ACTIONABLE additionally requires score ≥ ${minActionable}, turnover ≥ ₹${minTurnover} Cr, flow confirmation, a workable entry location and acceptable reversal risk.`,
      "Missing optional evidence (flow, OI, structure) lowers confidence but never disqualifies an otherwise valid candidate, and is never scored as zero-signal agreement.",
    ],
  };
}

export { MAX_SCORE as DOMINANCE_MAX_SCORE, W as DOMINANCE_WEIGHTS, staleMsDefault };
const staleMsDefault = 60_000;
