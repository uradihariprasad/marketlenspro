"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Scale, TrendingUp, TrendingDown, Loader2, AlertTriangle, ChevronRight, Info } from "lucide-react";
import type { TerminalPayload } from "../ui";
import { Color, fmtCnt, fmtNum, fmtIst, NoteList } from "../ui";

// ---- view types mirroring the dominance engine output
interface Factor { k: string; v: number; detail: string; mode: string }
interface Candidate {
  rank: number; instrumentKey: string; symbol: string; side: "BUYER" | "SELLER";
  ltp: number; changePct: number; score: number; factors: Factor[];
  deltaRatio: number | null; cvdSlope: number | null; flowStatus: string; flowMode: string; attributionPct: number;
  cvdState: string; normalizedDelta: number | null; deltaAcceleration: number | null;
  deltaConsistency: number | null; cvdNow: number | null; cvdBasis: string | null;
  priceConfirmsFlow: boolean; divergence: { detected: boolean; bearish: boolean; note: string } | null;
  rvol: number | null; rvolMode: string; volumeStatus: string;
  trend: string; structureNote: string;
  nearestSupport: number | null; nearestResistance: number | null;
  supportLabel: string | null; resistanceLabel: string | null;
  nextTarget: number | null; targetRoomPct: number | null;
  reversalRisk: { level: string; reasons: string[] };
  action: string; actionReason: string; entryLocation: string; quality: string; why: string[];
  liquidityTier?: string; turnoverCr?: number | null;
  changeBasis?: string;
  changeExact?: boolean;
}
interface DominanceResponse {
  ok: boolean; state: string; reason?: string; marketPhase?: string; scanAt?: number | null;
  dominance?: {
    asOf: number; buyers: Candidate[]; sellers: Candidate[];
    requested: number; evaluated: number; qualifiedBuyers: number; qualifiedSellers: number;
    shortfallNote: string | null;
    coverage: {
      eligibleUniverse: number; evaluated: number; withValidPriceVolume: number;
      withFlow: number; withStructure: number; stale: number; insufficientData: number;
      coveragePct: number; partial: boolean; universe: number; withQuotes: number;
    };
    settings?: { minScore: number; minActionableScore: number; minTurnoverCr: number };
    notes: string[];
  };
}

export default function Dominance({ payload, onPick }: { payload: TerminalPayload; onPick: (key: string) => void }) {
  const [res, setRes] = useState<DominanceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [topN, setTopN] = useState(5);
  const [open, setOpen] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (n: number) => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const r = await fetch(`/api/dominance?topN=${n}`, { cache: "no-store" });
      if (id !== seq.current) return;
      setRes((await r.json()) as DominanceResponse);
    } catch {
      if (id === seq.current) setRes({ ok: false, state: "FAILED", reason: "network error" });
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const boot = setTimeout(() => void load(topN), 0);
    const t = setInterval(() => void load(topN), 12000);
    return () => { clearTimeout(boot); clearInterval(t); };
  }, [topN, load]);

  const d = res?.dominance;

  return (
    <div className="fade-in space-y-4">
      {/* header + controls */}
      <div className="panel p-4">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <Scale size={15} className="text-cyan-300" />
          <h2 className="text-[13px] font-bold uppercase tracking-[0.12em] text-slate-300">Buyer / Seller Dominance</h2>
          <div className="flex overflow-hidden rounded-lg border border-slate-700">
            {[3, 5, 10].map((n) => (
              <button key={n} onClick={() => setTopN(n)} className={`px-3 py-1.5 text-[11px] font-bold ${topN === n ? "bg-cyan-400/15 text-cyan-300" : "text-slate-500 hover:text-slate-300"}`}>
                Top {n}
              </button>
            ))}
          </div>
          {loading && <Loader2 size={14} className="animate-spin text-slate-500" />}
          {d && (
            <span className="mono ml-auto text-[10px] text-slate-500">last scan {fmtIst(d.asOf)}</span>
          )}
        </div>

        {/* accurate, defined coverage metrics */}
        {d && (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] mono sm:grid-cols-4 lg:grid-cols-8">
              <Cov k="Eligible F&O" v={String(d.coverage.eligibleUniverse)} hint="total eligible F&O equities in the instrument master" />
              <Cov k="Evaluated" v={String(d.coverage.evaluated)} hint="instruments the scanner successfully processed this cycle" />
              <Cov k="Valid price/vol" v={String(d.coverage.withValidPriceVolume)} hint="met minimum data eligibility for ranking" />
              <Cov k="Usable flow" v={String(d.coverage.withFlow)} tone={d.coverage.withFlow === 0 ? "text-amber-300" : "text-emerald-300"} hint="enough observations for a Delta/CVD estimate" />
              <Cov k="Structure" v={String(d.coverage.withStructure)} hint="instruments with completed market-structure analysis" />
              <Cov k="Stale/failed" v={String(d.coverage.stale + d.coverage.insufficientData)} tone={d.coverage.stale + d.coverage.insufficientData > 0 ? "text-rose-300" : undefined} />
              <Cov k="Buyers / Sellers" v={`${d.qualifiedBuyers} / ${d.qualifiedSellers}`} hint="candidates found (before the Top-N cut)" />
              <Cov k="Coverage" v={`${d.coverage.coveragePct.toFixed(0)}%`} tone={d.coverage.partial ? "text-amber-300" : "text-emerald-300"} />
            </div>
            {d.coverage.partial && (
              <p className="mt-2 rounded-lg border border-amber-400/25 bg-amber-400/5 px-2.5 py-1.5 text-[11px] text-amber-200/90">
                <b>PARTIAL SCAN:</b> {d.coverage.evaluated} of {d.coverage.eligibleUniverse} eligible F&amp;O stocks evaluated this cycle
                ({d.coverage.coveragePct.toFixed(0)}%). Remaining instruments are refreshed on the rotating schedule — results are not
                presented as a full-universe snapshot.
              </p>
            )}
            {d.settings && (
              <p className="mt-1.5 text-[10px] text-slate-600">
                Settings — ranking floor {d.settings.minScore} · actionable floor {d.settings.minActionableScore} · actionable liquidity ≥ ₹{d.settings.minTurnoverCr} Cr
              </p>
            )}
          </>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          Dominance measures <b className="text-slate-300">evidence of pressure</b>, not a trade signal. A strong score with a poor entry
          location is marked <span className="tag estimated">watchlist only</span>. Delta/CVD are <b>ESTIMATED</b> from REST snapshots and
          normalised per instrument, so raw Delta is never compared across stocks of different liquidity.
        </p>
      </div>

      {/* non-loaded states */}
      {res && !d && (
        <div className="panel grid place-items-center p-14 text-center">
          <AlertTriangle size={22} className="mb-3 text-amber-400" />
          <p className="text-sm font-semibold text-slate-300">
            {res.state === "REQUIRES_TOKEN" ? "Dominance needs live quotes" : res.state === "FAILED" ? "Request failed" : "Waiting for the first scan"}
          </p>
          <p className="mt-1 max-w-lg text-[12px] text-slate-500">{res.reason}</p>
          <span className={`tag mt-3 ${res.state === "LOADED" ? "exact" : res.state === "PENDING" ? "estimated" : "unavailable"}`}>{res.state}</span>
        </div>
      )}

      {d && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Board
              title="Top Buyer Dominance"
              icon={<TrendingUp size={14} className="text-emerald-400" />}
              rows={d.buyers}
              requested={d.requested}
              qualified={d.qualifiedBuyers}
              open={open}
              setOpen={setOpen}
              onPick={onPick}
            />
            <Board
              title="Top Seller Dominance"
              icon={<TrendingDown size={14} className="text-rose-400" />}
              rows={d.sellers}
              requested={d.requested}
              qualified={d.qualifiedSellers}
              open={open}
              setOpen={setOpen}
              onPick={onPick}
            />
          </div>

          {d.shortfallNote && (
            <div className="panel border-amber-400/20 p-3 text-[11px] text-amber-200/90">
              <Info size={12} className="mr-1 inline" /> {d.shortfallNote}
            </div>
          )}
          <NoteList notes={d.notes} />
          {payload.status.tokenStatus !== "VALID" && (
            <p className="text-[11px] text-slate-600">Connect an Upstox token for live dominance; without it the scanner runs on prior-session EOD data.</p>
          )}
        </>
      )}
    </div>
  );
}

function Board({
  title, icon, rows, requested, qualified, open, setOpen, onPick,
}: {
  title: string; icon: React.ReactNode; rows: Candidate[]; requested: number; qualified: number;
  open: string | null; setOpen: (s: string | null) => void; onPick: (k: string) => void;
}) {
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-800 p-3">
        {icon}
        <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">{title}</h3>
        <span className="mono ml-auto text-[10px] text-slate-600">{rows.length}/{requested} shown · {qualified} qualified</span>
      </div>
      {rows.length === 0 && (
        <div className="p-6 text-[12px] text-slate-600">
          No instrument currently meets the dominance floor on this side. Slots are left empty rather than padded with weak candidates.
        </div>
      )}
      {rows.map((c) => {
        const id = `${c.side}|${c.instrumentKey}`;
        const isOpen = open === id;
        return (
          <div key={id} className="border-b border-slate-800/60">
            <button onClick={() => setOpen(isOpen ? null : id)} className="w-full px-3 py-2.5 text-left transition hover:bg-slate-800/20">
              <div className="flex items-center gap-2">
                <span className="mono w-5 text-[11px] text-slate-600">#{c.rank}</span>
                <span className="mono w-20 truncate text-[13px] font-semibold text-slate-100">{c.symbol}</span>
                <span className="mono text-[11px] text-slate-400">{fmtNum(c.ltp, 2)}</span>
                <span className="mono text-[11px]"><Color v={c.changePct} suffix="%" /></span>
                <span className="mono ml-auto text-[13px] font-bold text-cyan-300">{c.score.toFixed(0)}</span>
                <ChevronRight size={13} className={`text-slate-600 transition ${isOpen ? "rotate-90" : ""}`} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <span className={`tag ${c.action === "ACTIONABLE" ? "exact" : c.action === "WATCHLIST_ONLY" || c.action === "RANKED_CANDIDATE" ? "estimated" : "unavailable"}`}>
                  {c.action.replace(/_/g, " ").toLowerCase()}
                </span>
                {c.changeExact === false && (
                  <span className="tag unavailable" title={c.changeBasis}>change indeterminate</span>
                )}
                {c.liquidityTier && (
                  <span className={`tag ${c.liquidityTier === "HIGH" ? "exact" : c.liquidityTier === "MODERATE" ? "approximate" : "unavailable"}`} title={c.turnoverCr != null ? `turnover ₹${c.turnoverCr.toFixed(0)} Cr` : undefined}>
                    {c.liquidityTier.toLowerCase()} liq
                  </span>
                )}
                <span className={`tag ${c.flowMode === "ESTIMATED" ? "estimated" : "unavailable"}`}>
                  flow {c.flowStatus.toLowerCase()}{c.flowMode === "ESTIMATED" ? ` ${c.attributionPct.toFixed(0)}%` : ""}
                </span>
                <span
                  className={`tag ${c.cvdState.startsWith("STRONG") ? "exact" : c.cvdState.startsWith("WEAKENING") || c.cvdState === "NEUTRAL" ? "estimated" : c.cvdState === "INSUFFICIENT_DATA" ? "unavailable" : "approximate"}`}
                  title={c.cvdBasis ?? "CVD momentum state (ESTIMATED)"}
                >
                  cvd {c.cvdState.replace(/_/g, " ").toLowerCase()}
                </span>
                {c.divergence?.detected && <span className="tag unavailable" title={c.divergence.note}>divergence</span>}
                {c.rvol !== null && <span className="tag approximate">rvol {c.rvol.toFixed(1)}×</span>}
                <span className="tag">{c.trend.toLowerCase()} structure</span>
                <span className={`tag ${c.reversalRisk.level === "LOW" ? "exact" : c.reversalRisk.level === "MODERATE" ? "estimated" : "unavailable"}`}>
                  reversal {c.reversalRisk.level.toLowerCase()}
                </span>
              </div>
            </button>

            {isOpen && (
              <div className="space-y-3 border-t border-slate-800/60 bg-slate-900/40 p-3">
                <p className="text-[11px] text-slate-400">{c.actionReason}</p>

                <div className="grid grid-cols-2 gap-2 text-[11px] mono sm:grid-cols-4">
                  <KV k="Support" v={c.nearestSupport !== null ? fmtNum(c.nearestSupport, 1) : "—"} hint={c.supportLabel ?? undefined} />
                  <KV k="Resistance" v={c.nearestResistance !== null ? fmtNum(c.nearestResistance, 1) : "—"} hint={c.resistanceLabel ?? undefined} />
                  <KV k="Next target" v={c.nextTarget !== null ? fmtNum(c.nextTarget, 1) : "—"} hint={c.targetRoomPct !== null ? `${c.targetRoomPct.toFixed(2)}% room` : undefined} />
                  <KV k="Entry location" v={c.entryLocation.replace(/_/g, " ").toLowerCase()} />
                  <KV k="Est. delta" v={c.deltaRatio !== null ? `${(c.deltaRatio * 100).toFixed(0)}%` : "—"} hint="share of attributable volume" />
                  <KV k="CVD slope" v={c.cvdSlope !== null ? fmtCnt(c.cvdSlope) : "—"} />
                  <KV k="Volume" v={c.volumeStatus.toLowerCase()} />
                  <KV k="Data" v={c.quality} />
                  <KV k="Normalised Δ" v={c.normalizedDelta !== null ? `${c.normalizedDelta.toFixed(0)}%` : "—"} hint="delta as % of CLASSIFIED volume" />
                  <KV k="Δ acceleration" v={c.deltaAcceleration !== null ? (c.deltaAcceleration > 0 ? "building" : c.deltaAcceleration < 0 ? "fading" : "flat") : "—"} />
                  <KV k="Δ consistency" v={c.deltaConsistency !== null ? `${(c.deltaConsistency * 100).toFixed(0)}%` : "—"} hint="share of recent bars agreeing" />
                  <KV k="Session CVD" v={c.cvdNow !== null ? fmtCnt(c.cvdNow) : "—"} hint={c.cvdBasis ?? undefined} />
                </div>

                {!c.priceConfirmsFlow && c.cvdState !== "INSUFFICIENT_DATA" && (
                  <p className="rounded-lg border border-amber-400/25 bg-amber-400/5 px-2.5 py-1.5 text-[11px] text-amber-200/90">
                    Price has <b>not</b> confirmed the flow direction over this window — treat the pressure as unconfirmed.
                  </p>
                )}
                {c.divergence?.detected && (
                  <p className="rounded-lg border border-rose-400/25 bg-rose-400/5 px-2.5 py-1.5 text-[11px] text-rose-200/90">
                    {c.divergence.note}
                  </p>
                )}
                {c.cvdBasis && <p className="text-[10px] text-slate-600">{c.cvdBasis}</p>}

                <div>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Why it ranks here</p>
                  {c.why.map((w, i) => (<p key={i} className="text-[11px] text-slate-400">▸ {w}</p>))}
                </div>

                <div>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Score breakdown (0-100)</p>
                  {c.factors.map((f, i) => (
                    <div key={i} className="flex items-baseline justify-between gap-2 text-[11px]">
                      <span className="text-slate-400">{f.k} <span className={`tag ${f.mode.toLowerCase()}`}>{f.mode.toLowerCase()}</span></span>
                      <span className="mono text-slate-200">{f.v > 0 ? "+" : ""}{f.v.toFixed(1)}</span>
                    </div>
                  ))}
                </div>

                {c.reversalRisk.reasons.length > 0 && (
                  <div>
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Reversal / failure risks</p>
                    {c.reversalRisk.reasons.map((r, i) => (<p key={i} className="text-[11px] text-amber-200/80">▸ {r}</p>))}
                  </div>
                )}

                <button
                  onClick={() => onPick(c.instrumentKey)}
                  className="rounded-lg bg-cyan-400 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-950 transition hover:bg-cyan-300"
                >
                  Open full intelligence →
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Cov({ k, v, hint, tone }: { k: string; v: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2 py-1.5" title={hint}>
      <div className="truncate text-[8px] uppercase tracking-wider text-slate-500">{k}</div>
      <div className={`truncate ${tone ?? "text-slate-200"}`}>{v}</div>
    </div>
  );
}

function KV({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2.5 py-2" title={hint}>
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{k}</div>
      <div className="truncate text-slate-200">{v}</div>
    </div>
  );
}
