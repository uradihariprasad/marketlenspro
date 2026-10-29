/**
 * Historical Replay & End-of-Day Analytics (Phase 3.9 / 4).
 *
 * REPLAY CORRECTNESS (no look-ahead, rule 7):
 *  At every replay step t_i the scenario engine receives ONLY the prefix of
 *  candles strictly available at t_i (all provider historical bars are
 *  closed). Indicators/structure/zones are recomputed on that prefix, in the
 *  SAME canonical functions the live engine uses. No future bar, future OI
 *  snapshot, or later confirmation can influence a past step — pivots are
 *  additionally right-bar confirmed, so a pivot never appears before it
 *  would have been knowable in real time.
 *
 *  Data-quality during replay is 'HISTORICAL' and order-flow/chain context
 *  are null (no stored tick or chain history for past sessions) — those
 *  confirmations appear as PENDING, never fabricated.
 *
 *  EOD analytics score each unique replay signal against the REMAINING bars
 *  of the same session (after its creation): did it reach target 1 first,
 *  hit the invalidation first, or go nowhere (EOD)? This is descriptive
 *  replay statistics — not a performance guarantee and not a backtest edge.
 */

import { Candle, round4, istDateKey } from "./types";
import { resample, inSession, dedupeSort } from "./candles";
import { analyzeStructure } from "./structure";
import { atrSeries, lastOf } from "./indicators";
import { computeProfile } from "./volumeProfile";
import { buildZones } from "./srEngine";
import { deriveSignals } from "./signals";

export interface ReplayStep {
  t: number;
  signals: { id: string; scenario: string; direction: string; score: number; entry: number | null }[];
}

export interface ReplayedSignal {
  id: string;
  scenario: string;
  direction: "LONG" | "SHORT";
  firstSeenAt: number;
  entry: number | null;
  stop: number | null;
  targets: number[];
  score: number;
  grade: string;
  outcome: "TP1" | "SL" | "EOD" | "OPEN";
  outcomeDetail: string;
}

export interface ReplayResult {
  instrumentKey: string;
  timeframeMin: number;
  sessionDate: string;
  barsReplayed: number;
  steps: ReplayStep[];
  signals: ReplayedSignal[];
  zonesAtEnd: number;
  notes: string[];
}

export function runReplay(args: {
  instrumentKey: string;
  oneMin: Candle[];
  timeframeMin: number;
  tickSize: number;
  sessionDate: string; // IST YYYY-MM-DD to replay
  contextDays?: number;
}): ReplayResult | { error: string } {
  const tf = args.timeframeMin;
  const all = dedupeSort(inSession(args.oneMin));
  // mark everything closed: replay consumes only completed provider bars
  const bars = resample(all, tf, Date.parse(args.sessionDate + "T15:40:00+05:30"));
  const sessionBars = bars.filter((c) => istDateKey(c.t) === args.sessionDate);
  if (sessionBars.length < 45) return { error: "insufficient replay history for this session" };

  const warmUp = 40;
  const steps: ReplayStep[] = [];
  const seen = new Map<string, ReplayedSignal>();

  for (let i = warmUp; i <= sessionBars.length; i++) {
    const prefix = sessionBars.slice(0, i).map((c) => ({ ...c, closed: true }));
    const now = prefix[prefix.length - 1].t + tf * 60_000;
    const structure = analyzeStructure(prefix);
    const atr = lastOf(atrSeries(prefix, 14)) ?? 0;
    if (atr <= 0) continue;
    const zones = buildZones({
      instrumentKey: args.instrumentKey,
      timeframeMin: tf,
      candles: prefix,
      structure,
      profile: computeProfile(prefix.filter((c) => {
        const d = new Date(c.t + 5.5 * 3_600_000).toISOString().slice(0, 10);
        return d === args.sessionDate;
      }), args.tickSize),
      oiLevels: null,
      tickSize: args.tickSize,
      atr,
      prevSessionHigh: null,
      prevSessionLow: null,
      prevSessionClose: null,
      now,
    });
    const sigs = deriveSignals({
      instrumentKey: args.instrumentKey,
      timeframeMin: tf,
      candles: prefix,
      structure,
      zones,
      flow: null,
      chainCtx: null,
      atr,
      tickSize: args.tickSize,
      dataQuality: "HISTORICAL",
      now,
    });
    steps.push({
      t: prefix[prefix.length - 1].t,
      signals: sigs.map((s) => ({ id: s.id, scenario: s.scenario, direction: s.direction, score: s.score, entry: s.entry })),
    });
    for (const s of sigs) {
      if (!seen.has(s.id)) {
        seen.set(s.id, {
          id: s.id, scenario: s.scenario, direction: s.direction,
          firstSeenAt: now, entry: s.entry, stop: s.stop, targets: s.targets,
          score: s.score, grade: s.grade, outcome: "OPEN", outcomeDetail: "pending",
        });
      }
    }
  }

  // ---- EOD outcome analysis over remaining bars of the same session
  const notes: string[] = [
    "Replay used prefix-only recomputation per step (no look-ahead): every step saw only bars closed strictly before it.",
    "Order-flow and option-chain context are unavailable in historical replay — related confirmations surface as PENDING.",
  ];
  for (const rs of seen.values()) {
    const afterIdx = sessionBars.findIndex((c) => c.t >= rs.firstSeenAt);
    if (rs.entry === null || rs.stop === null || afterIdx < 0) {
      rs.outcome = "EOD";
      rs.outcomeDetail = "no trigger/stop defined";
      continue;
    }
    const tp1 = rs.targets[0];
    const risk = Math.abs(rs.entry - rs.stop);
    let outcome: ReplayedSignal["outcome"] = "OPEN";
    let detail = "neither target nor invalidation reached before session end";
    for (let j = afterIdx; j < sessionBars.length; j++) {
      const bar = sessionBars[j];
      if (rs.direction === "LONG") {
        if (bar.c >= rs.entry && j === afterIdx && bar.l <= rs.stop) { outcome = "SL"; detail = `invalidation ${rs.stop} touched before entry filled`; break; }
        // conservative sequencing: stop evaluated before target within a bar
        if (bar.l <= rs.stop) { outcome = "SL"; detail = `invalidation ${rs.stop} hit (bar ${j - afterIdx + 1})`; break; }
        if (tp1 !== undefined && bar.h >= tp1) { outcome = "TP1"; detail = `target 1 ${tp1} reached after ${j - afterIdx + 1} bars (risk ${round4(risk)})`; break; }
      } else {
        if (afterIdx === j && bar.c <= rs.entry && bar.h >= rs.stop) { outcome = "SL"; detail = `invalidation ${rs.stop} touched before entry filled`; break; }
        if (bar.h >= rs.stop) { outcome = "SL"; detail = `invalidation ${rs.stop} hit (bar ${j - afterIdx + 1})`; break; }
        if (tp1 !== undefined && bar.l <= tp1) { outcome = "TP1"; detail = `target 1 ${tp1} reached after ${j - afterIdx + 1} bars (risk ${round4(risk)})`; break; }
      }
    }
    rs.outcome = outcome;
    rs.outcomeDetail = detail;
  }

  const tp = [...seen.values()].filter((s) => s.outcome === "TP1").length;
  const sl = [...seen.values()].filter((s) => s.outcome === "SL").length;
  notes.push(`replay stats (descriptive, not predictive): ${seen.size} unique candidates — ${tp} reached T1, ${sl} invalidated, ${seen.size - tp - sl} unresolved by session end`);

  // zones at end for cross-check
  const finalPrefix = sessionBars.map((c) => ({ ...c, closed: true }));
  const finalZones = buildZones({
    instrumentKey: args.instrumentKey, timeframeMin: tf, candles: finalPrefix,
    structure: analyzeStructure(finalPrefix), profile: computeProfile(finalPrefix, args.tickSize),
    oiLevels: null, tickSize: args.tickSize,
    atr: lastOf(atrSeries(finalPrefix, 14)) ?? 0.05, now: sessionBars[sessionBars.length - 1].t,
  });

  return {
    instrumentKey: args.instrumentKey,
    timeframeMin: tf,
    sessionDate: args.sessionDate,
    barsReplayed: sessionBars.length,
    steps: steps.filter((s) => s.signals.length > 0),
    signals: [...seen.values()],
    zonesAtEnd: finalZones.length,
    notes,
  };
}
