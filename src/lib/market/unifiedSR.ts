/**
 * Unified Support & Resistance decision layer.
 *
 * ROOT CAUSE THIS FIXES: `srEngine.buildZones()` (price-structure zones) and
 * `oiIntelligence.buildOiZones()` (OI-derived candidates) were computed by
 * two engines that never met. The chart consumed only structural zones; the
 * OI tab consumed only OI zones; nothing produced an IMMEDIATE vs PRIMARY
 * distinction. This module is the single decision layer both consume.
 *
 * It does NOT recompute structure or OI. It merges the existing outputs and
 * selects four levels with two DIFFERENT rules:
 *   - IMMEDIATE = proximity (nearest valid level on the correct side)
 *   - PRIMARY   = strength  (highest confluence on the correct side)
 * so the two can legitimately be different levels.
 *
 * Invariants:
 *  - OI-only evidence never becomes a price-confirmed zone.
 *  - A support is always below spot; a resistance always above.
 *  - When no reliable level exists, an explicit unavailable state is returned.
 */

import { Zone, round4 } from "./types";
import type { OiWindow, TotalOiRow, OiZone, StrikePosture } from "./oiIntelligence";

// ------------------------------------------------------------------- types

export type SrRole = "IMMEDIATE_SUPPORT" | "PRIMARY_SUPPORT" | "IMMEDIATE_RESISTANCE" | "PRIMARY_RESISTANCE";

export type SupportState =
  | "STRONG_SUPPORT" | "SUPPORT_STRENGTHENING" | "WEAK_SUPPORT"
  | "SUPPORT_WEAKENING" | "SUPPORT_BREAKDOWN_RISK";
export type ResistanceState =
  | "STRONG_RESISTANCE" | "RESISTANCE_STRENGTHENING" | "WEAK_RESISTANCE"
  | "RESISTANCE_WEAKENING" | "RESISTANCE_BREAKOUT_RISK";
export type SrState = SupportState | ResistanceState;

export interface SrEvidence {
  k: string;
  detail: string;
  weight: number;
  source: "STRUCTURE" | "PROFILE" | "VWAP" | "OI_5M" | "OI_15M" | "OI_SESSION" | "OI_TOTAL" | "PREMIUM" | "FLOW" | "REACTION";
}

export interface UnifiedLevel {
  id: string;
  role: SrRole;
  side: "SUPPORT" | "RESISTANCE";
  /** Representative price plus the zone band it came from. */
  price: number;
  lower: number;
  upper: number;
  distancePct: number;
  state: SrState;
  /** 0..100 transparent confluence score. NOT a probability. */
  score: number;
  /** STRUCTURAL zones are price-confirmed; OI_CANDIDATE never is. */
  provenance: "STRUCTURAL" | "OI_CANDIDATE" | "CONFLUENCE";
  priceConfirmed: boolean;
  confirmation: "CONFIRMED" | "CANDIDATE";
  evidence: SrEvidence[];
  contributingStrikes: number[];
  invalidation: string;
  updatedAt: number;
}

export interface UnifiedSR {
  instrumentKey: string;
  spot: number | null;
  immediateSupport: UnifiedLevel | null;
  primarySupport: UnifiedLevel | null;
  immediateResistance: UnifiedLevel | null;
  primaryResistance: UnifiedLevel | null;
  /** Every merged candidate, for chart overlays and the summary panel. */
  all: UnifiedLevel[];
  unavailable: { support: string | null; resistance: string | null };
  notes: string[];
  updatedAt: number;
}

export interface UnifiedSrInput {
  instrumentKey: string;
  spot: number | null;
  /** Existing price-structure zones from srEngine.buildZones(). */
  structural: Zone[];
  /** Existing OI candidates from oiIntelligence.buildOiZones(). */
  oiZones: OiZone[];
  /** OI windows for strengthening / weakening evaluation. */
  w5?: OiWindow | null;
  w15?: OiWindow | null;
  session?: OiWindow | null;
  totalOi?: TotalOiRow[];
  postures?: StrikePosture[];
  /** Shared ESTIMATED Delta/CVD pressure (-1..1), or null when unavailable. */
  flowPressure?: number | null;
  atr?: number | null;
  /** Previously emitted levels — enables hysteresis against flickering. */
  previous?: UnifiedSR | null;
  now?: number;
}

// ------------------------------------------------------------- scoring

/** Hysteresis: a new level must beat the incumbent by this margin to replace it. */
const REPLACE_MARGIN = 8;
/** Zones closer than this fraction of ATR are treated as the same level. */
const CLUSTER_ATR_FRACTION = 0.5;

function changeAt(w: OiWindow | null | undefined, strike: number, side: "CE" | "PE"): number | null {
  if (!w || w.status !== "OK") return null;
  const r = w.rows.find((x) => x.strike === strike);
  return side === "CE" ? r?.ceChange ?? null : r?.peChange ?? null;
}

/**
 * Evaluate OI behaviour around a level and translate it into a lifecycle
 * state plus evidence. Rising Call OI is NEVER automatically resistance and
 * rising Put OI is NEVER automatically support: premium direction and the
 * underlying's reaction are required to separate writing from buying.
 */
function evaluateOiBehaviour(
  side: "SUPPORT" | "RESISTANCE",
  strikes: number[],
  inp: UnifiedSrInput
): { evidence: SrEvidence[]; strengthening: number; weakening: number } {
  const evidence: SrEvidence[] = [];
  const optSide: "CE" | "PE" = side === "RESISTANCE" ? "CE" : "PE";
  let strengthening = 0;
  let weakening = 0;

  const sum = (w: OiWindow | null | undefined) =>
    strikes.reduce<number | null>((acc, s) => {
      const v = changeAt(w, s, optSide);
      if (v === null) return acc;
      return (acc ?? 0) + v;
    }, null);

  const c5 = sum(inp.w5);
  const c15 = sum(inp.w15);
  const cS = sum(inp.session);

  // 5-minute window = short-term change
  if (c5 !== null) {
    const building = c5 > 0;
    evidence.push({
      k: `5m ${optSide} OI`,
      detail: `${c5 > 0 ? "+" : ""}${Math.round(c5)} contracts (${building ? "building" : "unwinding"})`,
      weight: building ? 8 : -8,
      source: "OI_5M",
    });
    if (building) strengthening++; else if (c5 < 0) weakening++;
  } else {
    evidence.push({ k: "5m OI", detail: inp.w5?.reason ?? "unavailable", weight: 0, source: "OI_5M" });
  }

  // 15-minute window = broader context
  if (c15 !== null) {
    const building = c15 > 0;
    evidence.push({
      k: `15m ${optSide} OI`,
      detail: `${c15 > 0 ? "+" : ""}${Math.round(c15)} contracts (${building ? "sustained build" : "unwinding"})`,
      weight: building ? 10 : -10,
      source: "OI_15M",
    });
    if (building) strengthening++; else if (c15 < 0) weakening++;
  } else {
    evidence.push({ k: "15m OI", detail: inp.w15?.reason ?? "unavailable", weight: 0, source: "OI_15M" });
  }

  // session = context only, never the sole determinant
  if (cS !== null) {
    evidence.push({
      k: `session ${optSide} OI`,
      detail: `${cS > 0 ? "+" : ""}${Math.round(cS)} contracts since the session reference`,
      weight: cS > 0 ? 4 : -4,
      source: "OI_SESSION",
    });
  }

  // premium behaviour distinguishes possible writing from buying
  const relevant = (inp.postures ?? []).filter((p) => strikes.includes(p.strike) && p.side === optSide);
  for (const p of relevant) {
    const writing = p.posture === "POSSIBLE_CALL_WRITING" || p.posture === "POSSIBLE_PUT_WRITING";
    const buying = p.posture === "POSSIBLE_CALL_BUYING" || p.posture === "POSSIBLE_PUT_BUYING";
    evidence.push({
      k: `premium @ ${p.strike}`,
      detail: p.note,
      // writing at the level supports the level; buying does NOT
      weight: writing ? 8 : buying ? -4 : 0,
      source: "PREMIUM",
    });
    if (writing) strengthening++;
    if (buying) weakening++;
  }

  // total OI concentration as background context
  const conc = (inp.totalOi ?? []).filter((t) => strikes.includes(t.strike));
  if (conc.length > 0) {
    const oi = conc.reduce((a, t) => a + ((optSide === "CE" ? t.ceOi : t.peOi) ?? 0), 0);
    const peak = Math.max(...(inp.totalOi ?? []).map((t) => (optSide === "CE" ? t.ceOi : t.peOi) ?? 0), 1);
    const ratio = oi / peak;
    evidence.push({
      k: `${optSide} OI concentration`,
      detail: `${Math.round(ratio * 100)}% of the peak ${optSide} OI at this expiry`,
      weight: round4(ratio * 10),
      source: "OI_TOTAL",
    });
  }
  return { evidence, strengthening, weakening };
}

/** Translate evidence counts + price position into a lifecycle state. */
function resolveState(
  side: "SUPPORT" | "RESISTANCE",
  strengthening: number,
  weakening: number,
  priceConfirmed: boolean,
  accepted: boolean,
  score: number
): SrState {
  if (side === "SUPPORT") {
    if (accepted) return "SUPPORT_BREAKDOWN_RISK";
    if (weakening >= 2 && weakening > strengthening) return "SUPPORT_WEAKENING";
    if (strengthening >= 2 && priceConfirmed && score >= 55) return "STRONG_SUPPORT";
    if (strengthening >= 1) return "SUPPORT_STRENGTHENING";
    return "WEAK_SUPPORT";
  }
  if (accepted) return "RESISTANCE_BREAKOUT_RISK";
  if (weakening >= 2 && weakening > strengthening) return "RESISTANCE_WEAKENING";
  if (strengthening >= 2 && priceConfirmed && score >= 55) return "STRONG_RESISTANCE";
  if (strengthening >= 1) return "RESISTANCE_STRENGTHENING";
  return "WEAK_RESISTANCE";
}

interface Candidate {
  price: number;
  lower: number;
  upper: number;
  side: "SUPPORT" | "RESISTANCE";
  provenance: "STRUCTURAL" | "OI_CANDIDATE" | "CONFLUENCE";
  priceConfirmed: boolean;
  baseScore: number;
  evidence: SrEvidence[];
  strikes: number[];
  invalidation: string;
}

/** Merge structural + OI candidates, clustering levels that are effectively the same. */
function mergeCandidates(inp: UnifiedSrInput): Candidate[] {
  const spot = inp.spot;
  if (spot === null) return [];
  const atr = inp.atr && inp.atr > 0 ? inp.atr : Math.max(spot * 0.002, 0.05);
  const tol = atr * CLUSTER_ATR_FRACTION;
  const out: Candidate[] = [];

  // 1. price-structure zones (the only ones that may be price-confirmed)
  for (const z of inp.structural) {
    if (z.state === "BROKEN") continue; // never offer a traversed level as active
    const side: "SUPPORT" | "RESISTANCE" = z.upper < spot ? "SUPPORT" : z.lower > spot ? "RESISTANCE" : z.mid <= spot ? "SUPPORT" : "RESISTANCE";
    const reactions = z.touches.filter((t) => t.reaction !== "PASS").length;
    const ev: SrEvidence[] = [
      { k: "structural zone", detail: `${z.state.toLowerCase()} · ${z.confirmationStatus.toLowerCase()} (score ${z.score})`, weight: Math.min(30, z.score * 6), source: "STRUCTURE" },
    ];
    if (reactions > 0) ev.push({ k: "price reactions", detail: `${reactions} confirmed reaction(s) at this zone`, weight: Math.min(18, reactions * 6), source: "REACTION" });
    for (const s of z.sources.slice(0, 4)) {
      const src: SrEvidence["source"] = s.kind.startsWith("PROFILE") ? "PROFILE" : s.kind === "VWAP" ? "VWAP" : "STRUCTURE";
      ev.push({ k: s.kind.toLowerCase().replace(/_/g, " "), detail: s.detail, weight: 0, source: src });
    }
    out.push({
      price: z.mid, lower: z.lower, upper: z.upper, side,
      provenance: "STRUCTURAL",
      priceConfirmed: z.confirmationStatus === "CONFIRMED",
      baseScore: Math.min(45, z.score * 9),
      evidence: ev,
      strikes: [],
      invalidation: `sustained close beyond ${round4(z.invalidation)}`,
    });
  }

  // 2. OI candidates — merge into a structural zone when they coincide,
  //    otherwise stand alone as explicitly unconfirmed candidates.
  for (const oz of inp.oiZones) {
    const side = oz.kind;
    const near = out.find((c) => c.side === side && Math.abs(c.price - oz.strike) <= tol);
    const oiEv: SrEvidence = {
      k: "OI concentration",
      detail: `${oz.classification.replace(/_/g, " ").toLowerCase()} at strike ${oz.strike} (OI score ${oz.score.toFixed(0)})`,
      weight: Math.min(20, oz.score * 0.2),
      source: "OI_TOTAL",
    };
    if (near) {
      // CONFLUENCE: price structure + OI agree at the same level
      near.provenance = near.provenance === "STRUCTURAL" ? "CONFLUENCE" : near.provenance;
      near.evidence.push(oiEv);
      near.strikes.push(oz.strike);
      near.baseScore = Math.min(70, near.baseScore + 12);
    } else {
      out.push({
        price: oz.strike, lower: oz.strike, upper: oz.strike, side,
        provenance: "OI_CANDIDATE",
        priceConfirmed: false, // OI alone is NEVER price-confirmed
        baseScore: Math.min(30, oz.score * 0.3),
        evidence: [oiEv],
        strikes: [oz.strike],
        invalidation: oz.invalidation,
      });
    }
  }
  return out;
}

// -------------------------------------------------------------------- main

export function buildUnifiedSR(inp: UnifiedSrInput): UnifiedSR {
  const now = inp.now ?? Date.now();
  const spot = inp.spot;
  const notes: string[] = [
    "IMMEDIATE levels are selected by proximity; PRIMARY levels by confluence strength — they are deliberately different rules and may differ.",
    "OI-only levels stay unconfirmed candidates; only price-action evidence confirms a level.",
    "Rising Call OI is not automatically resistance and rising Put OI is not automatically support — premium and price reaction are evaluated.",
  ];

  if (spot === null || !Number.isFinite(spot)) {
    return {
      instrumentKey: inp.instrumentKey, spot: null,
      immediateSupport: null, primarySupport: null, immediateResistance: null, primaryResistance: null,
      all: [], unavailable: { support: "no spot price reference", resistance: "no spot price reference" },
      notes, updatedAt: now,
    };
  }

  const merged = mergeCandidates(inp);
  const levels: UnifiedLevel[] = [];

  for (const c of merged) {
    /**
     * Enforce correct sidedness against the representative price. A zone
     * whose band straddles spot is RE-SIDED rather than discarded, so a level
     * price is pressing into is never silently dropped from the output.
     */
    if (c.side === "SUPPORT" && c.price > spot) c.side = "RESISTANCE";
    if (c.side === "RESISTANCE" && c.price < spot) c.side = "SUPPORT";

    const oi = evaluateOiBehaviour(c.side, c.strikes, inp);
    const evidence = [...c.evidence, ...oi.evidence];

    // ESTIMATED flow as supporting evidence only
    let flowAdj = 0;
    if (inp.flowPressure !== null && inp.flowPressure !== undefined) {
      const helps = c.side === "SUPPORT" ? inp.flowPressure > 0.15 : inp.flowPressure < -0.15;
      const hurts = c.side === "SUPPORT" ? inp.flowPressure < -0.15 : inp.flowPressure > 0.15;
      if (helps || hurts) {
        flowAdj = helps ? 6 : -6;
        evidence.push({
          k: "ESTIMATED Delta/CVD",
          detail: `${helps ? "supports" : "opposes"} this level (pressure ${inp.flowPressure.toFixed(2)})`,
          weight: flowAdj,
          source: "FLOW",
        });
      }
    }

    const evidenceScore = evidence.reduce((a, e) => a + e.weight, 0);
    const score = round4(Math.max(0, Math.min(100, c.baseScore + evidenceScore)));

    // "accepted beyond" = price has moved decisively through the level
    const atr = inp.atr && inp.atr > 0 ? inp.atr : spot * 0.002;
    const accepted = c.side === "SUPPORT" ? spot < c.lower - atr * 0.5 : spot > c.upper + atr * 0.5;
    const state = resolveState(c.side, oi.strengthening, oi.weakening, c.priceConfirmed, accepted, score);

    levels.push({
      id: `${inp.instrumentKey}|${c.side}|${round4(c.price)}`,
      role: c.side === "SUPPORT" ? "IMMEDIATE_SUPPORT" : "IMMEDIATE_RESISTANCE", // refined below
      side: c.side,
      price: round4(c.price),
      lower: round4(c.lower),
      upper: round4(c.upper),
      distancePct: round4(((c.price - spot) / spot) * 100),
      state,
      score,
      provenance: c.provenance,
      priceConfirmed: c.priceConfirmed,
      confirmation: c.priceConfirmed ? "CONFIRMED" : "CANDIDATE",
      evidence,
      contributingStrikes: [...new Set(c.strikes)],
      invalidation: c.invalidation,
      updatedAt: now,
    });
  }

  const supports = levels.filter((l) => l.side === "SUPPORT");
  const resistances = levels.filter((l) => l.side === "RESISTANCE");

  // IMMEDIATE = proximity (nearest to spot), tie-break on confirmation then score
  const byProximity = (a: UnifiedLevel, b: UnifiedLevel) => {
    const da = Math.abs(a.price - spot);
    const db = Math.abs(b.price - spot);
    if (Math.abs(da - db) > 1e-9) return da - db;
    if (a.priceConfirmed !== b.priceConfirmed) return a.priceConfirmed ? -1 : 1;
    return b.score - a.score;
  };
  // PRIMARY = strength (highest confluence), tie-break on proximity
  const byStrength = (a: UnifiedLevel, b: UnifiedLevel) =>
    b.score - a.score || Math.abs(a.price - spot) - Math.abs(b.price - spot);

  const immediateSupport = [...supports].sort(byProximity)[0] ?? null;
  const immediateResistance = [...resistances].sort(byProximity)[0] ?? null;

  // Hysteresis: keep the incumbent primary unless a challenger clears the margin
  const pickPrimary = (pool: UnifiedLevel[], prev: UnifiedLevel | null): UnifiedLevel | null => {
    const sorted = [...pool].sort(byStrength);
    const top = sorted[0] ?? null;
    if (!top || !prev) return top;
    const incumbent = pool.find((l) => Math.abs(l.price - prev.price) < 1e-9);
    if (!incumbent) return top;
    return top.score >= incumbent.score + REPLACE_MARGIN ? top : incumbent;
  };
  const primarySupport = pickPrimary(supports, inp.previous?.primarySupport ?? null);
  const primaryResistance = pickPrimary(resistances, inp.previous?.primaryResistance ?? null);

  if (immediateSupport) immediateSupport.role = "IMMEDIATE_SUPPORT";
  if (immediateResistance) immediateResistance.role = "IMMEDIATE_RESISTANCE";
  if (primarySupport) primarySupport.role = "PRIMARY_SUPPORT";
  if (primaryResistance) primaryResistance.role = "PRIMARY_RESISTANCE";

  return {
    instrumentKey: inp.instrumentKey,
    spot,
    immediateSupport,
    primarySupport,
    immediateResistance,
    primaryResistance,
    all: levels.sort((a, b) => a.price - b.price),
    unavailable: {
      support: supports.length === 0 ? "no valid support zone below the current price" : null,
      resistance: resistances.length === 0 ? "no valid resistance zone above the current price" : null,
    },
    notes,
    updatedAt: now,
  };
}
