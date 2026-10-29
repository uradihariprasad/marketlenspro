/**
 * Trade candidate & scenario engine (Part H + Part G integration).
 *
 * DISCIPLINE (rules 8, 9, 14, 22-24):
 *  - Returns an EMPTY list when no defined scenario satisfies its conditions —
 *    the scanner never forces a trade.
 *  - Scores are deterministic confluence scores with an explicit breakdown;
 *    they are NOT calibrated probabilities of winning.
 *  - Every signal is traceable: `trace.rules` enumerates the exact checks
 *    with observed values; `trace.inputs` records the inputs used.
 *  - OI-only zones are usable as context/targets but a signal's structural
 *    trigger zone must be CONFIRMED when provenance is OI_CANDIDATE
 *    (price-confirmed upgrade recorded by the S/R engine).
 *  - Order-flow evidence is ESTIMATED (tick-rule) and tagged; when unavailable
 *    the signal degrades to "pending confirmation" rather than pretending
 *    confirmation exists.
 *  - Data quality gate: signals are only produced on LIVE/HISTORICAL-complete
 *    candles; callers mark stale regimes and expire outstanding signals.
 */

import {
  Candle, Zone, Signal, DataQuality, round4, alignToTick,
} from "./types";
import type { StructureResult } from "./structure";
import type { FlowContext } from "./orderflow";
import { emaSeries, vwapSeries, rsiSeries, lastOf } from "./indicators";
import { zoneMap } from "./srEngine";

export interface ChainCtx {
  pcrOi: number | null;
  maxPain: number | null;
}

/**
 * Multi-timeframe OI evidence for a trade candidate. Each window is derived
 * from timestamped observations (never scaled from another window), and
 * `available: false` means the window genuinely has no baseline yet.
 */
export interface OiWindowEvidence {
  available: boolean;
  reason: string;
  /** Net CE OI change summed across the strikes nearest the level. */
  ceChange: number | null;
  peChange: number | null;
  /** +1 bullish / -1 bearish / 0 neutral, from put-minus-call OI build. */
  bias: 1 | -1 | 0;
}

export interface OiTradeContext {
  w5: OiWindowEvidence;
  w15: OiWindowEvidence;
  session: OiWindowEvidence;
  totalCeOi: number | null;
  totalPeOi: number | null;
  /** Agreement between the 5m and 15m windows. */
  agreement: "ALIGNED" | "CONFLICTING" | "UNKNOWN";
  momentumState: string | null;
  /** Possible-writing / possible-buying notes near the traded level. */
  postureNotes: string[];
}

export interface SignalInput {
  instrumentKey: string;
  timeframeMin: number;
  candles: Candle[];
  structure: StructureResult;
  zones: Zone[];
  flow: FlowContext | null;
  /**
   * Shared ESTIMATED flow confirmation (same object the scanner consumes, so
   * the two can never disagree). Null/unavailable => no flow score, and the
   * signal records flow confirmation as PENDING rather than assuming it.
   */
  flowConfirm?: {
    status: string;
    available: boolean;
    reason: string;
    deltaRatio: number | null;
    cvdSlope: number | null;
    attributionPct: number;
    score: number;
    label: string;
  } | null;
  chainCtx: ChainCtx | null;
  /** Multi-timeframe OI evidence (5m / 15m / session / total). */
  oiCtx?: OiTradeContext | null;
  /** Unified immediate + primary S/R used for targets and invalidation. */
  unifiedLevels?: {
    immediateSupport: number | null;
    primarySupport: number | null;
    immediateResistance: number | null;
    primaryResistance: number | null;
  } | null;
  atr: number;
  tickSize: number;
  dataQuality: DataQuality;
  now?: number;
}

function median20Vol(closed: Candle[]): number {
  const vs = closed.slice(-21, -1).map((c) => c.v).sort((a, b) => a - b);
  return vs.length ? vs[Math.floor(vs.length / 2)] : 0;
}

export function deriveSignals(inp: SignalInput): Signal[] {
  const now = inp.now ?? Date.now();
  const out: Signal[] = [];
  const dq = inp.dataQuality;
  if (dq === "UNAVAILABLE" || dq === "STALE" || dq === "PARTIAL") return out;

  const closed = inp.candles.filter((c) => c.closed);
  const n = closed.length;
  if (n < 40 || inp.atr <= 0) return out;

  const last = closed[n - 1];
  const closes = closed.map((c) => c.c);
  const ema9 = emaSeries(closes, 9);
  const ema21 = emaSeries(closes, 21);
  const vwap = vwapSeries(closed);
  const rsi = rsiSeries(closes, 14);
  const e9 = lastOf(ema9);
  const e21 = lastOf(ema21);
  const vw = lastOf(vwap);
  const rsiNow = lastOf(rsi);
  const atr = inp.atr;
  const medVol = median20Vol(closed);
  const volExpansion = medVol > 0 && last.v > 1.5 * medVol;

  const fc = inp.flowConfirm ?? null;
  const flowTags = fc?.available
    ? ["DELTA:ESTIMATED", "CVD:ESTIMATED", `FLOW:${fc.status}`, `ATTRIB:${Math.round(fc.attributionPct)}%`]
    : inp.flow
      ? ["DELTA:ESTIMATED", "CVD:ESTIMATED", "FLOW:UNCONFIRMED"]
      : ["DELTA:UNAVAILABLE"];

  /**
   * Apply ESTIMATED order-flow evidence for a given direction.
   *
   * - Uses the SHARED flowConfirmation score (delta ratio primary, CVD slope
   *   as a correlated agreement bonus) so delta and CVD are never counted as
   *   two independent confirmations.
   * - When flow is unavailable/insufficient/stale the signal gains NOTHING and
   *   records an explicit pending confirmation — it is never called
   *   "flow-confirmed" and is never penalised for missing coverage.
   */
  /**
   * Apply multi-timeframe OI evidence to a directional setup.
   *
   * Rules:
   *  - 5m = recent positioning, 15m = persistence/context, session+total = backdrop.
   *  - A 5m-vs-15m CONFLICT is surfaced as pending confirmation and penalised;
   *    it never forces a bullish or bearish classification.
   *  - OI alone can never create a setup: it only adjusts an existing
   *    price-action scenario's score and confirmations.
   *  - Unavailable windows contribute exactly 0 (never assumed neutral/zero).
   */
  const applyOi = (
    dir: "LONG" | "SHORT",
    breakdown: { k: string; v: number }[],
    rules: string[],
    pending: string[]
  ): void => {
    const oi = inp.oiCtx ?? null;
    if (!oi) {
      pending.push("multi-timeframe OI evidence unavailable (no option-chain observations)");
      return;
    }
    const want = dir === "LONG" ? 1 : -1;

    if (oi.agreement === "CONFLICTING") {
      breakdown.push({ k: "CONFLICTING 5m vs 15m OI", v: -0.8 });
      rules.push("5-minute OI positioning opposes the 15-minute structure — conflict recorded, direction NOT forced");
      pending.push("await price confirmation to resolve the 5m/15m OI conflict");
    }

    for (const [label, w, weight] of [
      ["5m OI", oi.w5, 0.7] as const,
      ["15m OI", oi.w15, 0.9] as const,
      ["session OI", oi.session, 0.4] as const,
    ]) {
      if (!w.available) {
        pending.push(`${label} window unavailable: ${w.reason}`);
        continue;
      }
      if (w.bias === 0) {
        rules.push(`${label} neutral (CE ${w.ceChange ?? "n/a"}, PE ${w.peChange ?? "n/a"})`);
        continue;
      }
      const agrees = w.bias === want;
      breakdown.push({ k: `${label} ${agrees ? "confirms" : "opposes"} ${dir.toLowerCase()}`, v: agrees ? weight : -weight });
      rules.push(`${label}: CE ${w.ceChange ?? "n/a"}, PE ${w.peChange ?? "n/a"} → ${w.bias > 0 ? "bullish" : "bearish"} positioning`);
    }

    for (const note of oi.postureNotes.slice(0, 3)) rules.push(`premium/OI posture: ${note}`);
    if (oi.momentumState) rules.push(`OI momentum state: ${oi.momentumState.replace(/_/g, " ").toLowerCase()}`);
  };

  const applyFlow = (
    dir: "LONG" | "SHORT",
    breakdown: { k: string; v: number }[],
    rules: string[],
    pending: string[]
  ): void => {
    if (!fc || !fc.available) {
      pending.push(`order-flow confirmation unavailable (${fc?.reason ?? "no tracker observations"})`);
      return;
    }
    const aligned = dir === "LONG" ? fc.score > 0 : fc.score < 0;
    const magnitude = Math.min(Math.abs(fc.score), 1);
    if (aligned && magnitude >= 0.1) {
      breakdown.push({ k: `estimated flow confirms ${dir.toLowerCase()} (delta+CVD, ${fc.attributionPct.toFixed(0)}% attributed)`, v: round4(0.8 * magnitude) });
      rules.push(`ESTIMATED flow ${fc.status}: delta ratio ${fc.deltaRatio}, CVD slope ${fc.cvdSlope ?? "n/a"} — ${fc.reason}`);
    } else if (!aligned && magnitude >= 0.25) {
      breakdown.push({ k: "estimated flow contradicts direction", v: round4(-0.5 * magnitude) });
      rules.push(`CONTRADICTORY ESTIMATED flow: ${fc.reason}`);
      pending.push("estimated order flow currently opposes this direction");
    } else {
      pending.push(`estimated flow neutral (${fc.reason})`);
    }
  };
  const trendUp = inp.structure.trend === "UP";
  const trendDn = inp.structure.trend === "DOWN";
  const events = inp.structure.events;
  const recentChochUp = events.some((e) => e.type === "CHOCH_UP" && e.t >= closed[Math.max(0, n - 30)].t);
  const recentChochDn = events.some((e) => e.type === "CHOCH_DOWN" && e.t >= closed[Math.max(0, n - 30)].t);
  const recentBosUp = events.some((e) => e.type === "BOS_UP" && e.t >= closed[Math.max(0, n - 20)].t);
  const recentBosDn = events.some((e) => e.type === "BOS_DOWN" && e.t >= closed[Math.max(0, n - 20)].t);

  const base: Omit<Signal, "scenario" | "direction" | "entry" | "stop" | "targets" | "rr" | "score" | "breakdown" | "confirmations" | "pending" | "invalidationRule" | "trace" | "id" | "status"> = {
    instrumentKey: inp.instrumentKey,
    timeframeMin: inp.timeframeMin,
    capabilityTags: flowTags,
    dataQuality: dq,
    createdAt: now,
    updatedAt: now,
    validUntil: now + 45 * 60_000,
    grade: "POSSIBLE_TRADE",
  };

  const mkId = (scenario: string, direction: string, anchor: number) =>
    `${inp.instrumentKey}|${inp.timeframeMin}m|${scenario}|${direction}|${istAnchor(last.t)}|${Math.round(anchor / Math.max(inp.tickSize, 1))}`;
  const istAnchor = (t: number) => new Date(t).toISOString().slice(5, 16).replace(/[-:T]/g, "");

  // ------------------------------------------------ scenario 1: BREAKOUT_RETEST
  for (const z of inp.zones) {
    if (z.side !== "RESISTANCE" && z.side !== "BOTH") continue;
    if (z.provenanceGroup === "OI_CANDIDATE" && z.confirmationStatus !== "CONFIRMED") continue;
    const recent = closed.slice(-12);
    const brokeIdx = recent.findIndex((c) => c.c > z.upper);
    if (brokeIdx < 0) continue;
    const leg = recent[recent.length - 1];
    const pulledBack = leg.l <= z.upper + atr * 0.25 && leg.c > z.mid;
    const held = leg.c > z.upper - atr * 0.15;
    if (!pulledBack || !held) continue;

    const rules: string[] = [];
    rules.push(`resistance zone ${z.lower}–${z.upper} (${z.provenanceGroup}, ${z.confirmationStatus}) broken: close > ${z.upper}`);
    rules.push(`retest: last closed bar low ${leg.l} within zone + 0.25·ATR, close ${leg.c} held above mid ${z.mid}`);
    const breakdown: { k: string; v: number }[] = [];
    breakdown.push({ k: "breakout + retest structure", v: 2 });
    breakdown.push({ k: "zone confluence", v: round4(Math.min(3, z.score) * 0.5) });
    if (trendUp || recentChochUp || recentBosUp) {
      breakdown.push({ k: trendUp ? "uptrend structure" : "trend shift event", v: 1.5 });
      rules.push(trendUp ? "structure trend UP" : `trend shift event within 30 bars (${recentChochUp ? "CHoCH_UP" : "BOS_UP"})`);
    }
    const pending: string[] = [];
    if (volExpansion) { breakdown.push({ k: "volume expansion (>1.5×20-bar median)", v: 1 }); rules.push(`last closed bar volume ${Math.round(last.v)} > 1.5× median ${Math.round(medVol)}`); }
    applyFlow("LONG", breakdown, rules, pending);
    applyOi("LONG", breakdown, rules, pending);
    if (inp.chainCtx?.pcrOi !== null && inp.chainCtx?.pcrOi !== undefined) {
      const supportive = inp.chainCtx.pcrOi >= 1;
      breakdown.push({ k: "chain context (pcrOi)", v: supportive ? 0.5 : -0.3 });
      rules.push(`option PCR(OI) ${inp.chainCtx.pcrOi}`);
    }
    const entry = alignToTick(z.upper + inp.tickSize, inp.tickSize);
    const stop = alignToTick(Math.min(z.lower - 0.4 * atr, leg.l - 0.2 * atr), inp.tickSize);
    const risk = Math.max(entry - stop, inp.tickSize);
    const zm = zoneMap(z.upper * 1.001, inp.zones.filter((x) => x.id !== z.id));
    // Target 2 prefers the UNIFIED primary resistance (shared S/R engine) so
    // the Trade Finder, chart and S/R Map all reference the same levels.
    const unifiedT2 = inp.unifiedLevels?.primaryResistance ?? null;
    const zoneT2 = zm.nearestResistance ? zm.nearestResistance.mid : null;
    const targets = [
      alignToTick(entry + 1.5 * risk, inp.tickSize),
      unifiedT2 && unifiedT2 > entry ? unifiedT2 : zoneT2 ?? alignToTick(entry + 2.5 * risk, inp.tickSize),
    ];
    const rr = round4((targets[0] - entry) / risk);
    const status: Signal["status"] = last.c >= entry ? "ACTIVE" : "WATCH";
    const score = round4(breakdown.reduce((a, b) => a + b.v, 0));
    if (breakdown.reduce((a, b) => a + b.v, 0) < 3) continue;
    out.push({
      ...base, id: mkId("BREAKOUT_RETEST", "LONG", z.mid), scenario: "BREAKOUT_RETEST", direction: "LONG",
      status, entry, stop, targets, rr, score, breakdown,
      confirmations: rules.slice(0, 4), pending,
      invalidationRule: `sustained close below ${stop} (zone invalidation)`,
      trace: {
        rules,
        inputs: { lastClose: last.c, zoneLower: z.lower, zoneUpper: z.upper, zoneMid: z.mid, atr, medianVol20: Math.round(medVol), lastVol: last.v, rsi14: rsiNow, trend: inp.structure.trend },
      },
    });
  }

  // ------------------------------------------- scenario 2: REVERSAL_REJECTION
  for (const z of inp.zones) {
    if (z.side !== "RESISTANCE" && z.side !== "BOTH") continue;
    if (z.provenanceGroup === "OI_CANDIDATE" && z.confirmationStatus !== "CONFIRMED") continue;
    const touched = z.touches.some((t) => t.reaction === "REJECTION" && t.t >= closed[Math.max(0, n - 15)].t);
    const near = last.h >= z.lower && last.c < z.lower;
    if (!touched || !near) continue;
    const rules: string[] = [
      `wick rejection at ${z.provenanceGroup === "OI_CANDIDATE" ? "price-confirmed OI zone" : "structural zone"} ${z.lower}–${z.upper} within 15 bars`,
      `last closed bar: high ${last.h} probed ≥ ${z.lower}, close ${last.c} back below`,
    ];
    const breakdown: { k: string; v: number }[] = [
      { k: "rejection at confirmed zone", v: 2 },
      { k: "zone confluence", v: round4(Math.min(3, z.score) * 0.5) },
    ];
    const pending: string[] = ["bearish structure shift (lower low) to follow up"];
    applyFlow("SHORT", breakdown, rules, pending);
    applyOi("SHORT", breakdown, rules, pending);
    if (inp.flow?.divergence?.detected && inp.flow.divergence.bearish) { breakdown.push({ k: "estimated CVD divergence (warning)", v: 0.6 }); rules.push(inp.flow.divergence.note); pending.push("price-structure confirmation of divergence"); }
    if (rsiNow !== null && rsiNow > 68) { breakdown.push({ k: "rsi extended (>68)", v: 0.5 }); rules.push(`RSI14 ${rsiNow} extended`); }
    if (recentChochDn) { breakdown.push({ k: "CHoCH down within 30 bars", v: 1 }); rules.push("CHoCH_DOWN detected"); }
    const entry = alignToTick(z.lower - inp.tickSize, inp.tickSize);
    const stop = alignToTick(z.upper + atr * 0.5, inp.tickSize);
    const risk = Math.max(stop - entry, inp.tickSize);
    const zm = zoneMap(z.lower * 0.999, inp.zones.filter((x) => x.id !== z.id));
    const unifiedT2s = inp.unifiedLevels?.primarySupport ?? null;
    const zoneT2s = zm.nearestSupport ? zm.nearestSupport.mid : null;
    const targets = [
      alignToTick(entry - 1.5 * risk, inp.tickSize),
      unifiedT2s && unifiedT2s < entry ? unifiedT2s : zoneT2s ?? alignToTick(entry - 2.5 * risk, inp.tickSize),
    ].sort((a, b) => b - a);
    const score = round4(breakdown.reduce((a, b) => a + b.v, 0));
    if (score < 3) continue;
    out.push({
      ...base, id: mkId("REVERSAL_REJECTION", "SHORT", z.mid), scenario: "REVERSAL_REJECTION", direction: "SHORT",
      status: last.c <= entry ? "ACTIVE" : "WATCH",
      entry, stop, targets, rr: round4((entry - targets[0]) / risk), score, breakdown,
      confirmations: rules.slice(0, 4), pending,
      invalidationRule: `sustained close above ${stop}`,
      trace: { rules, inputs: { lastClose: last.c, lastHigh: last.h, zoneLower: z.lower, zoneUpper: z.upper, atr, rsi14: rsiNow, chochDnRecent: String(recentChochDn) } },
    });
  }

  // --------------------------------------------------- scenario 3: FAILED_BREAK (trapped)
  for (const z of inp.zones) {
    if (z.state !== "BROKEN") continue;
    const wasResistance = z.side === "RESISTANCE" || (z.side === "BOTH" && last.c < z.lower);
    const prior = closed.slice(-15, -2);
    const failed = wasResistance
      ? prior.some((c) => c.c > z.upper) && closed[n - 2].c < z.upper && last.c < z.upper
      : prior.some((c) => c.c < z.lower) && closed[n - 2].c > z.lower && last.c > z.lower;
    if (!failed) continue;
    const dir: Signal["direction"] = wasResistance ? "SHORT" : "LONG";
    const anchor = wasResistance ? z.upper : z.lower;
    const rules: string[] = [
      `failed ${wasResistance ? "upside break" : "downside break"} of zone ${z.lower}–${z.upper}: price returned inside prior range on two closes`,
      "potential trapped-trader scenario — see pending confirmation",
    ];
    const pending = ["follow-through structure event (BOS in signal direction)", "estimated delta confirmation"];
    const breakdown: { k: string; v: number }[] = [
      { k: "failed break structure", v: 2.2 },
      { k: "zone confluence", v: round4(Math.min(3, z.score) * 0.5) },
    ];
    applyFlow(dir, breakdown, rules, pending);
    applyOi(dir, breakdown, rules, pending);
    const entry = alignToTick(anchor + (dir === "SHORT" ? -1 : 1) * inp.tickSize, inp.tickSize);
    const stop = alignToTick(anchor + (dir === "SHORT" ? 1 : -1) * atr * 0.6, inp.tickSize);
    const risk = Math.abs(stop - entry);
    // Target 2 prefers the UNIFIED primary level so the Trade Finder, chart
    // and S/R Map always reference the same shared levels.
    const unifiedFar = dir === "SHORT" ? inp.unifiedLevels?.primarySupport ?? null : inp.unifiedLevels?.primaryResistance ?? null;
    const fallbackFar = alignToTick(dir === "SHORT" ? entry - 2 * risk : entry + 2 * risk, inp.tickSize);
    const farTarget =
      unifiedFar !== null && (dir === "SHORT" ? unifiedFar < entry : unifiedFar > entry) ? unifiedFar : fallbackFar;
    const targets = [
      alignToTick(dir === "SHORT" ? z.lower - 0.2 * atr : z.upper + 0.2 * atr, inp.tickSize),
      farTarget,
    ];
    const rr = round4(Math.abs(targets[0] - entry) / risk);
    const score = round4(breakdown.reduce((a, b) => a + b.v, 0));
    if (score < 3) continue;
    out.push({
      ...base, id: mkId("FAILED_BREAK", dir, z.mid), scenario: "FAILED_BREAK", direction: dir,
      status: dir === "SHORT" ? (last.c <= entry ? "ACTIVE" : "WATCH") : (last.c >= entry ? "ACTIVE" : "WATCH"),
      entry, stop, targets: dir === "SHORT" ? targets.sort((a, b) => b - a) : targets.sort((a, b) => a - b),
      rr, score, breakdown, confirmations: rules, pending,
      invalidationRule: `sustained close beyond ${stop} (re-break)`,
      trace: { rules, inputs: { lastClose: last.c, zoneLower: z.lower, zoneUpper: z.upper, atr, breakSide: wasResistance ? "upside" : "downside" } },
    });
    void anchor;
  }

  // Rule-defined decision-support categories (NOT win probabilities):
  //  GOOD_TRADE:    score >= 5, zero pending confirmations, RR to T1 >= 1.5, data LIVE
  //  POSSIBLE_TRADE: all other emitted candidates (score >= 3 by construction)
  //  NO_TRADE:      scenarios failing thresholds are simply never emitted.
  for (const s of out) {
    s.grade =
      s.score >= 5 && s.pending.length === 0 && (s.rr ?? 0) >= 1.5 && dq === "LIVE" ? "GOOD_TRADE" : "POSSIBLE_TRADE";
  }

  // sorted deterministically; dedupe overlapping by scenario+direction
  const seen = new Set<string>();
  return out
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .filter((s) => {
      const k = `${s.scenario}|${s.direction}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 6);
}

// keep numeric bag typed for trace.inputs
export type TraceInputs = Record<string, number | string | boolean | null>;
