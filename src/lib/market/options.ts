/**
 * Futures & Option Chain engine (Part F).
 *
 *  - Intraday change in OI = current OI − OI at the explicitly defined
 *    SESSION_REF snapshot (first successful chain fetch of the session,
 *    persisted to PostgreSQL). Provider `prev_oi` (prior-day reference) is
 *    displayed separately where present — the two references are never
 *    mixed (rule: validate definitions).
 *  - PCR computed TWICE, never mixed (rule: OI basis vs volume basis):
 *    pcrOi = ΣPE OI / ΣCE OI; pcrVol = ΣPE volume / ΣCE volume.
 *  - Max pain: strike minimizing total call+put payout at expiry.
 *  - Greeks/IV are provider values (status PROVIDER); no local IV surface.
 *  - Chain positioning feeds srEngine as OI_CANDIDATE zones — contextual
 *    evidence only, never proof of participant intent.
 */

import { RawChainStrike } from "./upstox";
import { OiLevel } from "./srEngine";
import { round4, istDateKey } from "./types";

export interface ChainRow {
  strike: number;
  ceOi: number; peOi: number;
  ceOiChg: number | null; peOiChg: number | null; // vs SESSION_REF (session start)
  ceOiChgPrev: number | null; peOiChgPrev: number | null; // vs previous chain snapshot (~60s)
  ceVol: number; peVol: number;
  ceLtp: number | null; peLtp: number | null;
  ceIv: number | null; peIv: number | null;
  ceDelta: number | null; peDelta: number | null;
  ceGamma: number | null; peGamma: number | null;
  ceTheta: number | null; peTheta: number | null;
  ceBid: number | null; ceAsk: number | null;
  peBid: number | null; peAsk: number | null;
}

export interface ChainAnalytics {
  underlyingKey: string;
  expiry: string; // YYYY-MM-DD
  spot: number | null;
  capturedAt: number;
  sessionDate: string;
  mode: "PROVIDER";
  atmStrike: number | null;
  pcrOi: number | null;
  pcrVol: number | null;
  maxPain: number | null;
  totalCeOi: number;
  totalPeOi: number;
  refCapturedAt: number | null; // SESSION_REF capture time
  rows: ChainRow[]; // ATM ± window for UI
  oiLevels: OiLevel[]; // for S/R engine
  notes: string[];
}

const WINDOW = 12; // strikes either side of ATM for UI rows

export function analyzeChain(
  chain: RawChainStrike[],
  underlyingKey: string,
  expiry: string,
  ref: Map<string, number> | null,
  refCapturedAt: number | null,
  now = Date.now(),
  spotOverride: number | null = null,
  prevSnap: Map<string, { ce: number; pe: number }> | null = null
): ChainAnalytics {
  const rows: ChainRow[] = [];
  let ceOi = 0;
  let peOi = 0;
  let ceVol = 0;
  let peVol = 0;
  let spot: number | null = spotOverride;

  for (const s of chain) {
    const cm = s.call_options?.market_data ?? {};
    const pm = s.put_options?.market_data ?? {};
    const cg = s.call_options?.option_greeks ?? {};
    const pg = s.put_options?.option_greeks ?? {};
    if (spot === null && typeof s.underlying_spot_price === "number" && s.underlying_spot_price > 0) {
      spot = s.underlying_spot_price;
    }
    const ceO = num0(cm.oi);
    const peO = num0(pm.oi);
    ceOi += ceO;
    peOi += peO;
    ceVol += num0(cm.volume);
    peVol += num0(pm.volume);
    const ceKey = s.call_options?.instrument_key ?? `CE@${s.strike_price}`;
    const peKey = s.put_options?.instrument_key ?? `PE@${s.strike_price}`;
    const sk = String(s.strike_price); // prev-chain baseline is keyed by strike
    rows.push({
      strike: s.strike_price,
      ceOi: ceO,
      peOi: peO,
      ceOiChg: ref && ref.has(ceKey) ? ceO - (ref.get(ceKey) as number) : null,
      peOiChg: ref && ref.has(peKey) ? peO - (ref.get(peKey) as number) : null,
      ceOiChgPrev: prevSnap && prevSnap.has(sk) ? ceO - prevSnap.get(sk)!.ce : null,
      peOiChgPrev: prevSnap && prevSnap.has(sk) ? peO - prevSnap.get(sk)!.pe : null,
      ceVol: num0(cm.volume),
      peVol: num0(pm.volume),
      ceLtp: numOrNull(cm.ltp),
      peLtp: numOrNull(pm.ltp),
      ceIv: numOrNull(cg.iv),
      peIv: numOrNull(pg.iv),
      ceDelta: numOrNull(cg.delta),
      peDelta: numOrNull(pg.delta),
      ceGamma: numOrNull(cg.gamma),
      peGamma: numOrNull(pg.gamma),
      ceTheta: numOrNull(cg.theta),
      peTheta: numOrNull(pg.theta),
      ceBid: numOrNull(cm.bid_price),
      ceAsk: numOrNull(cm.ask_price),
      peBid: numOrNull(pm.bid_price),
      peAsk: numOrNull(pm.ask_price),
    });
  }
  rows.sort((a, b) => a.strike - b.strike);

  const atmStrike = spot !== null && rows.length
    ? rows.reduce((best, r) => (Math.abs(r.strike - spot!) < Math.abs(best.strike - spot!) ? r : best), rows[0]).strike
    : null;

  // max pain across chain strikes
  let maxPain: number | null = null;
  if (rows.length) {
    let best = Infinity;
    for (const r of rows) {
      let pain = 0;
      for (const o of rows) {
        pain += o.ceOi * Math.max(0, r.strike - o.strike);
        pain += o.peOi * Math.max(0, o.strike - r.strike);
      }
      if (pain < best) {
        best = pain;
        maxPain = r.strike;
      }
    }
  }

  const atmIdx = atmStrike !== null ? rows.findIndex((r) => r.strike === atmStrike) : -1;
  const win = atmIdx >= 0 ? rows.slice(Math.max(0, atmIdx - WINDOW), atmIdx + WINDOW + 1) : rows;

  const notes = [
    "Delta/Gamma/Theta/Vega/IV are provider values (Upstox) — not locally derived.",
    "Intraday ΔOI is vs the session's first snapshot (SESSION_REF). Provider prev_oi, when present, references the PRIOR session and is not mixed in.",
    refCapturedAt === null ? "No SESSION_REF snapshot yet — ΔOI shown as pending until the reference snapshot exists." : "",
    "High Call OI is contextual, not unbreakable resistance; high Put OI is contextual, not guaranteed support.",
  ].filter(Boolean);

  return {
    underlyingKey,
    expiry,
    spot,
    capturedAt: now,
    sessionDate: istDateKey(now),
    mode: "PROVIDER",
    atmStrike,
    pcrOi: ceOi > 0 ? round4(peOi / ceOi) : null,
    pcrVol: ceVol > 0 ? round4(peVol / ceVol) : null,
    maxPain,
    totalCeOi: ceOi,
    totalPeOi: peOi,
    refCapturedAt,
    rows: win,
    oiLevels: rows.map((r) => ({ strike: r.strike, ceOi: r.ceOi, peOi: r.peOi, ceOiChg: r.ceOiChg ?? 0, peOiChg: r.peOiChg ?? 0 })),
    notes,
  };
}

/** Futures price/OI quadrant label — contextual context only (rule 11). */
export function futuresInterpretation(
  pricechgPct: number | null,
  oiChgPct: number | null
): { label: string; caveat: string } | null {
  if (pricechgPct === null || oiChgPct === null) return null;
  const up = pricechgPct > 0.05;
  const dn = pricechgPct < -0.05;
  const oiUp = oiChgPct > 0.5;
  const oiDn = oiChgPct < -0.5;
  let label: string | null = null;
  if (up && oiUp) label = "possible long build-up";
  else if (dn && oiUp) label = "possible short build-up";
  else if (up && oiDn) label = "possible short covering";
  else if (dn && oiDn) label = "possible long unwinding";
  else if (!up && !dn && (oiUp || oiDn)) label = oiUp ? "OI build-up, price flat" : "OI falling, price flat";
  if (!label) return null;
  return { label, caveat: "contextual interpretation — not a confirmed classification of participant intent" };
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function num0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
