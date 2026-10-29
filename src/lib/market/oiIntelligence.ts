/**
 * OI Strike Intelligence engine.
 *
 * Maintains TIMESTAMPED per-contract OI observations so 5-minute, 15-minute
 * and session-wide changes are each derived from real history — never by
 * scaling one window into another, and never fabricated.
 *
 * Honesty rules enforced here:
 *  - A window is UNAVAILABLE until an observation genuinely old enough exists
 *    (e.g. mid-session start has no 15m baseline yet).
 *  - Observations are keyed by underlying + expiry + strike + option type, so
 *    an expiry rollover never compares mismatched contracts.
 *  - OI concentration alone never establishes support/resistance; OI-derived
 *    zones stay CANDIDATE until price action confirms them elsewhere.
 *  - All positioning labels ("possible call writing" …) are probabilistic
 *    interpretations of OI + premium + underlying behaviour, not identification
 *    of any trader's actual position.
 */

import { round4, istDateKey } from "./types";

// ----------------------------------------------------------------- storage

export interface StrikeObservation {
  strike: number;
  ceOi: number | null;
  peOi: number | null;
  ceLtp: number | null;
  peLtp: number | null;
  ceVol: number | null;
  peVol: number | null;
}

export interface OiObservation {
  t: number;                       // capture timestamp (epoch ms)
  spot: number | null;
  expiry: string;                  // YYYY-MM-DD, part of the identity
  strikes: Map<number, StrikeObservation>;
}

/** Tolerance when matching a window baseline (polling is ~20s). */
const MATCH_TOLERANCE_MS = 150_000;
const MAX_OBSERVATIONS = 180;      // ~60 min at a 20s cadence

/**
 * Per-underlying+expiry ring buffer of timestamped OI observations.
 * Identity is (underlyingKey, expiry): a new expiry starts a new series so
 * baselines are never carried across contracts.
 */
export class OiHistory {
  private series = new Map<string, OiObservation[]>();

  private static id(underlyingKey: string, expiry: string): string {
    return `${underlyingKey}|${expiry}`;
  }

  record(underlyingKey: string, expiry: string, obs: OiObservation): void {
    const key = OiHistory.id(underlyingKey, expiry);
    const list = this.series.get(key) ?? [];
    const last = list[list.length - 1];
    // duplicate poll (identical timestamp) must not create a second point
    if (last && obs.t <= last.t) return;
    // session rollover: drop observations from a previous trading day
    const today = istDateKey(obs.t);
    const pruned = list.filter((o) => istDateKey(o.t) === today);
    pruned.push(obs);
    if (pruned.length > MAX_OBSERVATIONS) pruned.splice(0, pruned.length - MAX_OBSERVATIONS);
    this.series.set(key, pruned);
  }

  all(underlyingKey: string, expiry: string): OiObservation[] {
    return this.series.get(OiHistory.id(underlyingKey, expiry)) ?? [];
  }

  latest(underlyingKey: string, expiry: string): OiObservation | null {
    const l = this.all(underlyingKey, expiry);
    return l.length ? l[l.length - 1] : null;
  }

  /** Oldest observation retained for this contract series. */
  earliest(underlyingKey: string, expiry: string): OiObservation | null {
    const l = this.all(underlyingKey, expiry);
    return l.length ? l[0] : null;
  }

  /**
   * Observation closest to (now - windowMs). Returns null when no observation
   * is old enough — the caller must then report the window UNAVAILABLE rather
   * than substituting a nearer point.
   */
  baselineFor(underlyingKey: string, expiry: string, windowMs: number, now: number): OiObservation | null {
    const list = this.all(underlyingKey, expiry);
    if (list.length < 2) return null;
    const target = now - windowMs;
    let best: OiObservation | null = null;
    let bestGap = Infinity;
    for (const o of list) {
      if (o.t > target + MATCH_TOLERANCE_MS) continue; // too recent to represent the window
      const gap = Math.abs(o.t - target);
      if (gap < bestGap) {
        bestGap = gap;
        best = o;
      }
    }
    return best;
  }

  /** Drop a contract series (used on expiry rollover). */
  clear(underlyingKey: string, expiry: string): void {
    this.series.delete(OiHistory.id(underlyingKey, expiry));
  }

  stats(underlyingKey: string, expiry: string, now: number) {
    const list = this.all(underlyingKey, expiry);
    const span = list.length >= 2 ? now - list[0].t : 0;
    return { observations: list.length, spanMs: span, firstAt: list[0]?.t ?? null, lastAt: list[list.length - 1]?.t ?? null };
  }
}

// ------------------------------------------------------------- chart models

export type WindowStatus = "OK" | "COLLECTING" | "UNAVAILABLE";

export interface StrikeDelta {
  strike: number;
  ceChange: number | null;
  peChange: number | null;
  ceChangePct: number | null;
  peChangePct: number | null;
  ceOi: number | null;
  peOi: number | null;
}

export interface OiWindow {
  label: string;
  windowMs: number;
  status: WindowStatus;
  reason: string;
  baselineAt: number | null;
  currentAt: number | null;
  actualSpanMs: number | null;   // the REAL elapsed span, not the nominal one
  rows: StrikeDelta[];
}

export interface TotalOiRow {
  strike: number;
  ceOi: number | null;
  peOi: number | null;
}

// ---------------------------------------------------------- interpretation

export type OiPosture =
  | "POSSIBLE_CALL_WRITING"
  | "POSSIBLE_CALL_BUYING"
  | "POSSIBLE_PUT_WRITING"
  | "POSSIBLE_PUT_BUYING"
  | "POSSIBLE_CALL_UNWINDING"
  | "POSSIBLE_PUT_UNWINDING"
  | "NO_CLEAR_POSTURE";

export interface StrikePosture {
  strike: number;
  posture: OiPosture;
  side: "CE" | "PE";
  oiChange: number;
  premiumChange: number | null;
  note: string;
}

export type OiMomentumState =
  | "BULLISH_MOMENTUM_STRENGTHENING"
  | "BEARISH_MOMENTUM_STRENGTHENING"
  | "MOMENTUM_CONTINUING"
  | "MOMENTUM_WEAKENING"
  | "POSSIBLE_EXHAUSTION"
  | "POSSIBLE_BREAKOUT"
  | "POSSIBLE_BREAKDOWN"
  | "CONFLICTING_OI_SIGNALS"
  | "WAITING_FOR_PRICE_CONFIRMATION"
  | "INSUFFICIENT_DATA";

export interface OiZone {
  strike: number;
  kind: "SUPPORT" | "RESISTANCE";
  classification:
    | "STRONG"
    | "STRENGTHENING"
    | "WEAK"
    | "WEAKENING"
    | "BREAKOUT_RISK"
    | "BREAKDOWN_RISK";
  /** OI-derived candidates are NEVER price-confirmed by this engine alone. */
  provenance: "OI_CANDIDATE";
  confirmation: "CANDIDATE";
  score: number;                       // 0..100, transparent
  evidence: { k: string; v: string }[];
  contributingStrikes: number[];
  invalidation: string;
  sourceTimestamps: { current: number | null; baseline5m: number | null; baseline15m: number | null; session: number | null };
}

export interface OiIntelligence {
  underlyingKey: string;
  symbol: string;
  expiry: string;
  spot: number | null;
  atmStrike: number | null;
  /** ATM and the three strikes either side — a focus band, not a data limit. */
  focusStrikes: number[];
  strikeInterval: number | null;
  ladder: number[];                    // COMPLETE relevant ladder
  capturedAt: number;
  windows: { w5: OiWindow; w15: OiWindow; session: OiWindow };
  totalOi: TotalOiRow[];
  totals: { ceOi: number; peOi: number; pcrOi: number | null };
  concentration: { topCallStrikes: TotalOiRow[]; topPutStrikes: TotalOiRow[] };
  postures: StrikePosture[];
  momentum: {
    state: OiMomentumState;
    reasons: string[];
    agreement: "ALIGNED" | "CONFLICTING" | "UNKNOWN";
    exhaustionEvidence: string[];
  };
  zones: { primarySupport: OiZone | null; primaryResistance: OiZone | null; all: OiZone[] };
  history: { observations: number; spanMs: number; firstAt: number | null; lastAt: number | null };
  dataQuality: { status: "LIVE" | "STALE" | "UNAVAILABLE"; ageMs: number | null; notes: string[] };
}

// ------------------------------------------------------------- computation

function pct(change: number, base: number | null): number | null {
  if (base === null || base <= 0) return null;
  return round4((change / base) * 100);
}

/** Build one window's per-strike deltas from two REAL observations. */
export function buildWindow(
  label: string,
  windowMs: number,
  current: OiObservation | null,
  baseline: OiObservation | null,
  ladder: number[],
  minObservations: number,
  observationCount: number
): OiWindow {
  if (!current) {
    return { label, windowMs, status: "UNAVAILABLE", reason: "no option-chain observation captured yet", baselineAt: null, currentAt: null, actualSpanMs: null, rows: [] };
  }
  if (!baseline) {
    const reason =
      observationCount < minObservations
        ? `collecting history — no observation yet reaches back ${Math.round(windowMs / 60000)} minutes`
        : `no valid observation at the ${Math.round(windowMs / 60000)}-minute baseline`;
    return { label, windowMs, status: "COLLECTING", reason, baselineAt: null, currentAt: current.t, actualSpanMs: null, rows: [] };
  }
  const rows: StrikeDelta[] = [];
  for (const strike of ladder) {
    const c = current.strikes.get(strike);
    const b = baseline.strikes.get(strike);
    if (!c) continue;
    // A strike absent from the baseline cannot produce a change value.
    const ceChange = c.ceOi !== null && b?.ceOi != null ? round4(c.ceOi - b.ceOi) : null;
    const peChange = c.peOi !== null && b?.peOi != null ? round4(c.peOi - b.peOi) : null;
    rows.push({
      strike,
      ceChange,
      peChange,
      ceChangePct: ceChange !== null ? pct(ceChange, b?.ceOi ?? null) : null,
      peChangePct: peChange !== null ? pct(peChange, b?.peOi ?? null) : null,
      ceOi: c.ceOi,
      peOi: c.peOi,
    });
  }
  return {
    label,
    windowMs,
    status: "OK",
    reason: `${rows.length} strikes compared against the observation captured ${Math.round((current.t - baseline.t) / 1000)}s earlier`,
    baselineAt: baseline.t,
    currentAt: current.t,
    actualSpanMs: current.t - baseline.t,
    rows,
  };
}

/** Infer the dominant strike interval from the actual ladder (never hardcoded). */
export function inferStrikeInterval(ladder: number[]): number | null {
  if (ladder.length < 2) return null;
  const gaps = new Map<number, number>();
  for (let i = 1; i < ladder.length; i++) {
    const g = round4(ladder[i] - ladder[i - 1]);
    if (g > 0) gaps.set(g, (gaps.get(g) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [g, c] of gaps) {
    if (c > bestCount) {
      bestCount = c;
      best = g;
    }
  }
  return best;
}

/**
 * Classify positioning at a strike from OI change + premium change +
 * underlying direction. Probabilistic language is mandatory.
 */
export function classifyPosture(
  side: "CE" | "PE",
  oiChange: number,
  premiumChange: number | null,
  underlyingChange: number | null
): { posture: OiPosture; note: string } {
  const rising = oiChange > 0;
  const premUp = premiumChange !== null && premiumChange > 0;
  const premDown = premiumChange !== null && premiumChange < 0;
  const undUp = underlyingChange !== null && underlyingChange > 0;
  const undDown = underlyingChange !== null && underlyingChange < 0;

  if (side === "CE") {
    if (rising && premDown && !undUp) {
      return { posture: "POSSIBLE_CALL_WRITING", note: "call OI rising with falling premium while the underlying fails to advance — possible call writing (requires rejection evidence to treat as resistance)" };
    }
    if (rising && premUp && undUp) {
      return { posture: "POSSIBLE_CALL_BUYING", note: "call OI and premium rising with a rising underlying — possible call buying / long build-up (rising call OI is NOT automatically resistance)" };
    }
    if (!rising && oiChange < 0) {
      return { posture: "POSSIBLE_CALL_UNWINDING", note: premUp ? "call OI falling with rising premium — possible short covering" : "call OI falling with falling premium — possible long unwinding" };
    }
  } else {
    if (rising && premDown && !undDown) {
      return { posture: "POSSIBLE_PUT_WRITING", note: "put OI rising with falling premium while the underlying holds — possible put writing (requires acceptance evidence to treat as support)" };
    }
    if (rising && premUp && undDown) {
      return { posture: "POSSIBLE_PUT_BUYING", note: "put OI and premium rising with a falling underlying — possible put buying / long build-up (rising put OI is NOT automatically support)" };
    }
    if (!rising && oiChange < 0) {
      return { posture: "POSSIBLE_PUT_UNWINDING", note: premUp ? "put OI falling with rising premium — possible short covering" : "put OI falling with falling premium — possible long unwinding" };
    }
  }
  return { posture: "NO_CLEAR_POSTURE", note: "OI and premium movement do not form a clear positioning pattern" };
}

function sumChanges(rows: StrikeDelta[], pick: (r: StrikeDelta) => number | null): number {
  return rows.reduce((a, r) => a + (pick(r) ?? 0), 0);
}

/**
 * Momentum / exhaustion classification.
 *
 * Requires agreement across windows: a single 5-minute OI decline can never
 * by itself produce POSSIBLE_EXHAUSTION, and a conflict between the 5m and
 * the 15m/session structure is surfaced rather than forced into a direction.
 */
export function classifyOiMomentum(args: {
  w5: OiWindow;
  w15: OiWindow;
  session: OiWindow;
  underlyingChangePct: number | null;
  priceConfirms: boolean | null;
  flowPressure: number | null; // shared Delta/CVD pressure, -1..1 or null
}): OiIntelligence["momentum"] {
  const reasons: string[] = [];
  const exhaustion: string[] = [];
  const { w5, w15, session } = args;

  if (w5.status !== "OK" && w15.status !== "OK") {
    return {
      state: "INSUFFICIENT_DATA",
      reasons: [w5.reason, w15.reason].filter(Boolean),
      agreement: "UNKNOWN",
      exhaustionEvidence: [],
    };
  }

  // Net put-minus-call OI build is the directional OI bias for a window:
  // put writing / call unwinding leans bullish, and vice versa.
  const bias = (w: OiWindow): number | null => {
    if (w.status !== "OK") return null;
    const ce = sumChanges(w.rows, (r) => r.ceChange);
    const pe = sumChanges(w.rows, (r) => r.peChange);
    const scale = Math.max(Math.abs(ce) + Math.abs(pe), 1);
    return round4((pe - ce) / scale); // -1..1
  };
  const b5 = bias(w5);
  const b15 = bias(w15);
  const bSession = bias(session);

  if (b5 !== null) reasons.push(`5m OI bias ${b5 > 0 ? "bullish" : b5 < 0 ? "bearish" : "flat"} (${b5.toFixed(2)})`);
  if (b15 !== null) reasons.push(`15m OI bias ${b15 > 0 ? "bullish" : b15 < 0 ? "bearish" : "flat"} (${b15.toFixed(2)})`);
  if (bSession !== null) reasons.push(`session OI bias ${bSession > 0 ? "bullish" : bSession < 0 ? "bearish" : "flat"} (${bSession.toFixed(2)})`);

  const MIN = 0.12;
  const sig5 = b5 !== null && Math.abs(b5) >= MIN ? Math.sign(b5) : 0;
  const sig15 = b15 !== null && Math.abs(b15) >= MIN ? Math.sign(b15) : 0;
  const sigS = bSession !== null && Math.abs(bSession) >= MIN ? Math.sign(bSession) : 0;

  // explicit conflict detection (never force a direction)
  const conflict = (sig5 !== 0 && sig15 !== 0 && sig5 !== sig15) || (sig5 !== 0 && sigS !== 0 && sig5 !== sigS);
  const agreement: "ALIGNED" | "CONFLICTING" | "UNKNOWN" =
    sig5 === 0 && sig15 === 0 ? "UNKNOWN" : conflict ? "CONFLICTING" : "ALIGNED";

  if (conflict) {
    reasons.push("short-term OI positioning opposes the broader 15m/session structure");
    return { state: "CONFLICTING_OI_SIGNALS", reasons, agreement, exhaustionEvidence: exhaustion };
  }

  const dir = sig5 || sig15 || sigS;
  const undDir = args.underlyingChangePct === null ? 0 : Math.sign(args.underlyingChangePct);

  /**
   * Magnitude comparison must use the per-minute RATE of directional OI
   * build, not the normalised bias (which is scale-invariant and therefore
   * always ±1 when only one side moves) and not raw totals (a 15m window
   * naturally accumulates more than a 5m window). Real elapsed spans are used
   * so an irregular polling cadence cannot distort the comparison.
   */
  const rate = (w: OiWindow): number | null => {
    if (w.status !== "OK") return null;
    const ce = sumChanges(w.rows, (r) => r.ceChange);
    const pe = sumChanges(w.rows, (r) => r.peChange);
    const span = w.actualSpanMs && w.actualSpanMs > 0 ? w.actualSpanMs : w.windowMs;
    if (!span || span <= 0) return null;
    return round4(Math.abs(pe - ce) / (span / 60_000)); // directional OI per minute
  };
  const r5 = rate(w5);
  const r15 = rate(w15);

  // Exhaustion requires MULTIPLE weakening observations, never one decline.
  const fading = r5 !== null && r15 !== null && r15 > 0 && r5 < r15 * 0.5;
  if (fading) exhaustion.push(`recent OI build rate (${r5?.toFixed(0)}/min) is materially weaker than the 15m rate (${r15?.toFixed(0)}/min)`);
  if (undDir !== 0 && dir !== 0 && undDir !== dir) exhaustion.push("underlying direction no longer agrees with OI positioning");
  if (args.flowPressure !== null && dir !== 0 && Math.sign(args.flowPressure) !== dir) {
    exhaustion.push("ESTIMATED Delta/CVD pressure opposes the OI positioning");
  }
  if (args.priceConfirms === false) exhaustion.push("price has not confirmed the positioning over the observation window");

  if (dir === 0) {
    return { state: "WAITING_FOR_PRICE_CONFIRMATION", reasons, agreement, exhaustionEvidence: exhaustion };
  }
  if (exhaustion.length >= 2) {
    return { state: "POSSIBLE_EXHAUSTION", reasons, agreement, exhaustionEvidence: exhaustion };
  }
  if (exhaustion.length === 1) {
    return { state: "MOMENTUM_WEAKENING", reasons, agreement, exhaustionEvidence: exhaustion };
  }
  if (args.priceConfirms !== true) {
    return { state: "WAITING_FOR_PRICE_CONFIRMATION", reasons, agreement, exhaustionEvidence: exhaustion };
  }
  // aligned, confirmed and accelerating (meaningfully faster build rate)
  const accelerating = r5 !== null && r15 !== null && r5 > r15 * 1.2;
  if (accelerating) {
    return {
      state: dir > 0 ? "BULLISH_MOMENTUM_STRENGTHENING" : "BEARISH_MOMENTUM_STRENGTHENING",
      reasons,
      agreement,
      exhaustionEvidence: exhaustion,
    };
  }
  return { state: "MOMENTUM_CONTINUING", reasons, agreement, exhaustionEvidence: exhaustion };
}

/**
 * OI-derived candidate zones. Deliberately CANDIDATE-only: OI concentration
 * cannot establish a price-confirmed level, so the price-based S/R engine
 * remains the authority for confirmation.
 */
export function buildOiZones(args: {
  totals: TotalOiRow[];
  w5: OiWindow;
  w15: OiWindow;
  session: OiWindow;
  spot: number | null;
  interval: number | null;
  timestamps: OiZone["sourceTimestamps"];
}): { primarySupport: OiZone | null; primaryResistance: OiZone | null; all: OiZone[] } {
  const { totals, spot } = args;
  if (spot === null || totals.length === 0) return { primarySupport: null, primaryResistance: null, all: [] };

  const maxCe = Math.max(...totals.map((t) => t.ceOi ?? 0), 1);
  const maxPe = Math.max(...totals.map((t) => t.peOi ?? 0), 1);
  const changeAt = (w: OiWindow, strike: number, side: "CE" | "PE"): number | null => {
    if (w.status !== "OK") return null;
    const row = w.rows.find((r) => r.strike === strike);
    return side === "CE" ? row?.ceChange ?? null : row?.peChange ?? null;
  };

  const zones: OiZone[] = [];
  for (const row of totals) {
    const isAbove = row.strike > spot;
    const isBelow = row.strike < spot;
    if (!isAbove && !isBelow) continue;
    const side: "CE" | "PE" = isAbove ? "CE" : "PE";
    const oi = (isAbove ? row.ceOi : row.peOi) ?? 0;
    const concentration = oi / (isAbove ? maxCe : maxPe); // 0..1
    if (concentration < 0.25) continue; // ignore insignificant strikes

    const c5 = changeAt(args.w5, row.strike, side);
    const c15 = changeAt(args.w15, row.strike, side);
    const cS = changeAt(args.session, row.strike, side);

    const evidence: { k: string; v: string }[] = [
      { k: "OI concentration", v: `${Math.round(concentration * 100)}% of peak ${side} OI at this expiry` },
      { k: "5m change", v: c5 === null ? "unavailable" : `${c5 > 0 ? "+" : ""}${Math.round(c5)}` },
      { k: "15m change", v: c15 === null ? "unavailable" : `${c15 > 0 ? "+" : ""}${Math.round(c15)}` },
      { k: "session change", v: cS === null ? "unavailable" : `${cS > 0 ? "+" : ""}${Math.round(cS)}` },
    ];

    // Build/unwind persistence drives strengthening vs weakening.
    const building = [c5, c15, cS].filter((v) => v !== null && v > 0).length;
    const unwinding = [c5, c15, cS].filter((v) => v !== null && v < 0).length;
    const nearSpot = args.interval ? Math.abs(row.strike - spot) <= args.interval * 1.5 : false;

    let classification: OiZone["classification"];
    if (building >= 2 && concentration >= 0.6) classification = "STRONG";
    else if (building >= 2) classification = "STRENGTHENING";
    else if (unwinding >= 2 && nearSpot) classification = isAbove ? "BREAKOUT_RISK" : "BREAKDOWN_RISK";
    else if (unwinding >= 2) classification = "WEAKENING";
    else if (concentration >= 0.6) classification = "STRONG";
    else classification = "WEAK";

    const score = round4(
      Math.min(100, concentration * 55 + building * 15 + (concentration >= 0.6 ? 10 : 0) - unwinding * 10)
    );

    zones.push({
      strike: row.strike,
      kind: isAbove ? "RESISTANCE" : "SUPPORT",
      classification,
      provenance: "OI_CANDIDATE",
      confirmation: "CANDIDATE",
      score: Math.max(0, score),
      evidence,
      contributingStrikes: [row.strike],
      invalidation: isAbove
        ? `sustained acceptance above ${row.strike} with ${side} OI unwinding`
        : `sustained acceptance below ${row.strike} with ${side} OI unwinding`,
      sourceTimestamps: args.timestamps,
    });
  }

  const supports = zones.filter((z) => z.kind === "SUPPORT").sort((a, b) => b.strike - a.strike || b.score - a.score);
  const resistances = zones.filter((z) => z.kind === "RESISTANCE").sort((a, b) => a.strike - b.strike || b.score - a.score);
  // primary = nearest significant zone on the correct side of spot
  const primarySupport = supports.find((z) => z.score >= 30) ?? supports[0] ?? null;
  const primaryResistance = resistances.find((z) => z.score >= 30) ?? resistances[0] ?? null;
  return { primarySupport, primaryResistance, all: zones.sort((a, b) => a.strike - b.strike) };
}

/** ATM = strike closest to spot, taken from the ACTUAL ladder. */
export function resolveAtm(ladder: number[], spot: number | null): number | null {
  if (spot === null || ladder.length === 0) return null;
  return ladder.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best), ladder[0]);
}

/** ATM and three strikes either side, using real ladder positions. */
export function focusBand(ladder: number[], atm: number | null): number[] {
  if (atm === null) return [];
  const i = ladder.indexOf(atm);
  if (i < 0) return [atm];
  return ladder.slice(Math.max(0, i - 3), Math.min(ladder.length, i + 4));
}
