"use client";

import { ArrowUpRight, ArrowDownRight, Flame, Droplets, AlertOctagon, ChevronRight } from "lucide-react";
import type { IndexCard, ScannerRow, TerminalPayload } from "../ui";
import { Color, fmtCnt, fmtNum, NoteList, CapTag } from "../ui";

export default function Dashboard({ payload, onPick }: { payload: TerminalPayload; onPick: (key: string) => void }) {
  const degraded = payload.status.tokenStatus !== "VALID";
  const sc = payload.scanner ?? payload.eodScanner ?? null;
  const usingEod = !payload.scanner && !!payload.eodScanner;
  return (
    <div className="fade-in space-y-5">
      {/* index cards */}
      <div className="grid gap-4 md:grid-cols-3">
        {payload.indexCards.map((c) => (
          <IndexCardView key={c.key} card={c} onPick={() => onPick(c.key)} />
        ))}
        {payload.indexCards.length === 0 && (
          <div className="panel col-span-3 p-6 text-sm text-slate-500">
            Index instruments pending — the instrument master is loading or unavailable. No substitute data is displayed.
          </div>
        )}
        {degraded && (
          <div className="panel p-3 text-[11px] text-amber-200/80 md:col-span-3">
            Index values shown from the last available quotes or prior-session EOD close (labelled per card) — real provider data with explicit quality flags; live P&amp;L ticks require a token.
          </div>
        )}
      </div>

      {payload.status.tokenStatus !== "VALID" && (
        <div className="panel border-amber-400/20 p-4 text-[12px] text-amber-200/90">
          Live quotes, option chains and order-flow are paused until an Upstox token is connected. Historical candles still load on the S/R Map tab.
        </div>
      )}

      {/* scanner */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-bold uppercase tracking-[0.12em] text-slate-300">
            Momentum Scanner
            {usingEod && <span className="tag estimated ml-2 align-middle">EOD snapshot — prior session, provider daily candles</span>}
            <span className="ml-2 text-slate-500 normal-case tracking-normal">F&O universe: {sc?.universeSize ?? 0} eligible stocks (live from instrument master)</span>
          </h2>
          {sc && <span className="text-[10px] text-slate-600 mono">rankings deterministic · scores ≠ win probability</span>}
        </div>
        {!sc && (
          <div className="panel p-6 text-sm text-slate-500">
            {payload.status.tokenStatus === "VALID"
              ? "Scanner is running its first cycle — the instrument universe and quotes are still loading."
              : "Waiting for the EOD baseline hydration (one daily-candle request per stock, runs in the background). Connect an Upstox token for the live intraday scanner."}
          </div>
        )}
        {sc && sc.bullish.length === 0 && sc.bearish.length === 0 && (
          <div className="panel border-amber-400/20 p-5 text-[12px] text-amber-200/90">
            <b>No directional momentum candidates.</b> The scanner evaluated {sc.coverage?.evaluated ?? sc.allRows?.length ?? "—"} of{" "}
            {sc.coverage?.eligible ?? sc.universeSize} eligible F&amp;O stocks. A stock only appears here when it shows a real
            directional move (≥0.25% and ≥0.2×ATR) — high relative volume alone is deliberately listed under
            &ldquo;High RVOL&rdquo; below, not as momentum.
            {sc.coverage && sc.coverage.refreshed < sc.coverage.eligible
              ? ` Only ${sc.coverage.refreshed}/${sc.coverage.eligible} stocks had fresh quotes this cycle.`
              : ""}
          </div>
        )}
        {sc && (sc.bullish.length > 0 || sc.bearish.length > 0) && (sc.rvolLeaders.length === 0) && (
          <div className="panel p-4 text-[12px] text-slate-500">
            No relative-volume data yet — RVOL needs a historical volume baseline, which hydrates in the background.
          </div>
        )}
        {sc && (
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
            <ScannerTable title="Top bullish momentum" icon={<ArrowUpRight size={14} className="text-emerald-400" />} rows={sc.bullish} onPick={onPick} />
            <ScannerTable title="Top bearish momentum" icon={<ArrowDownRight size={14} className="text-rose-400" />} rows={sc.bearish} onPick={onPick} />
            <ScannerTable title="High RVOL (participation, not direction)" icon={<Flame size={14} className="text-amber-400" />} rows={sc.rvolLeaders} metric="rvol" onPick={onPick} />
            <ScannerTable title="Most liquid (turnover)" icon={<Droplets size={14} className="text-blue-400" />} rows={sc.liquid} metric="turnover" onPick={onPick} />
          </div>
        )}
        {sc?.coverage && (
          <div className="panel mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 p-3 text-[11px]">
            <span className="font-bold uppercase tracking-wider text-slate-400">Scan coverage</span>
            <span className="mono text-slate-300">eligible {sc.coverage.eligible}</span>
            <span className="mono text-emerald-300">refreshed {sc.coverage.refreshed}</span>
            <span className="mono text-amber-300">stale {sc.coverage.stale}</span>
            <span className="mono text-rose-300">missing {sc.coverage.missingData}</span>
            <span className="mono text-slate-300">evaluated {sc.coverage.evaluated}</span>
            <span className="mono text-cyan-300">flow-confirmed {sc.coverage.flowConfirmed}</span>
            <span className="mono text-slate-500">flow-unavailable {sc.coverage.flowUnavailable}</span>
            <span className="mono text-slate-300">qualifying {sc.coverage.qualifying}</span>
            <span className="mono ml-auto text-slate-500">last update {new Date(sc.coverage.lastUpdate).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}</span>
          </div>
        )}
        {sc && <NoteList notes={sc.notes} />}
        {sc && sc.rejected.length > 0 && (
          <div className="mt-3 flex items-start gap-2 text-[11px] text-slate-500">
            <AlertOctagon size={13} className="mt-0.5 shrink-0 text-rose-400" />
            <span>
              Excluded for data quality: {sc.rejected.map((r) => `${r.symbol} (${r.reason.split(" — ")[0]})`).join(", ")}
              {sc.universeSize > 0 && " …"}
            </span>
          </div>
        )}
      </div>

      {/* alerts strip */}
      {payload.alerts.length > 0 && (
        <div className="panel p-4">
          <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Engine log</h3>
          <div className="scroll-thin max-h-36 space-y-1 overflow-y-auto">
            {payload.alerts.slice(0, 10).map((a) => (
              <div key={a.id} className="flex items-center gap-2 text-[11px]">
                <span className={`tag ${a.level === "ERROR" ? "unavailable" : a.level === "WARN" ? "estimated" : "provider"}`}>{a.level}</span>
                <span className="text-slate-400">{a.message}</span>
                <span className="mono ml-auto text-slate-600">{new Date(a.createdAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function IndexCardView({ card, onPick }: { card: IndexCard; onPick: () => void }) {
  const up = (card.changePct ?? 0) >= 0;
  return (
    <button onClick={onPick} className="panel panel-hover group p-5 text-left">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[12px] font-bold uppercase tracking-[0.12em] text-slate-400">{card.name}</h3>
        <ChevronRight size={14} className="text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-cyan-300" />
      </div>
      <div className="mt-2 flex items-end gap-3">
        <span className="mono text-2xl font-semibold text-slate-100">{card.spot !== null ? fmtNum(card.spot, 2) : "—"}</span>
        <span className="mono text-sm"><Color v={card.changePct} suffix="%" /></span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2">
          <div className="text-slate-500">FUTURES</div>
          <div className="mono text-slate-200">{card.futLtp !== null ? fmtNum(card.futLtp, 1) : "—"} <Color v={card.futChangePct} suffix="%" /></div>
          <div className="mono text-slate-500">OI {fmtCnt(card.futOi)}</div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2">
          <div className="text-slate-500">POSITIONING</div>
          <div className={`text-[11px] leading-snug ${card.interp?.includes("long") || card.interp?.includes("covering") ? (card.interp?.includes("short covering") ? "text-amber-300" : "text-emerald-300") : card.interp ? "text-rose-300" : "text-slate-500"}`}>
            {card.interp ?? "—"}
          </div>
        </div>
      </div>
      {card.chain && (
        <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-500 mono">
          <span>PCR(OI) {card.chain.pcrOi ?? "—"}</span>
          <span>·</span>
          <span>PCR(Vol) {card.chain.pcrVol ?? "—"}</span>
          <span>·</span>
          <span>MaxPain {card.chain.maxPain !== null ? fmtNum(card.chain.maxPain, 0) : "—"}</span>
          <span>·</span>
          <span>exp {card.chain.expiry}</span>
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <CapTag status={card.quality === "LIVE" ? "exact" : card.quality === "STALE" ? "estimated" : card.quality === "HISTORICAL" ? "estimated" : "unavailable"} />
        <span className="text-[10px] text-slate-600">{card.quality}</span>
        {card.quality === "HISTORICAL" && card.eodDate && <span className="tag estimated">EOD {card.eodDate}</span>}
        {card.interp && <span className="ml-auto text-[9px] text-slate-600">contextual, not confirmed intent</span>}
      </div>
    </button>
  );
}

function ScannerTable({
  title, icon, rows, metric = "score", onPick,
}: {
  title: string;
  icon: React.ReactNode;
  rows: ScannerRow[];
  metric?: "score" | "rvol" | "turnover";
  onPick: (key: string) => void;
}) {
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-800 p-3">
        {icon}
        <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">{title}</h3>
        <span className="ml-auto text-[10px] text-slate-600">{rows.length}</span>
      </div>
      <div className="scroll-thin max-h-[340px] overflow-y-auto">
        {rows.length === 0 && <div className="p-4 text-[12px] text-slate-600">No qualifying instruments right now.</div>}
        {rows.map((r) => (
          <button key={r.instrumentKey} onClick={() => onPick(r.instrumentKey)} className="block w-full border-b border-slate-800/50 px-3 py-2 text-left transition hover:bg-slate-800/20">
            <div className="flex items-center gap-2">
              <span className="mono w-20 truncate text-[12px] font-semibold text-slate-200">{r.symbol}</span>
              <span className="mono text-[11px] text-slate-400">{fmtNum(r.ltp, 2)}</span>
              <span className="mono ml-auto text-[11px]"><Color v={r.changePct} suffix="%" /></span>
              <span className="mono w-14 text-right text-[11px] text-amber-300">
                {metric === "rvol" ? (r.rvol !== null ? `${r.rvol.toFixed(1)}×` : "—") : metric === "turnover" ? (r.turnoverCr !== null ? `₹${r.turnoverCr.toFixed(0)}Cr` : "—") : r.score.toFixed(1)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {r.changeExact === false && (
                <span className="tag unavailable" title={r.changeBasis}>change indeterminate</span>
              )}
              {r.momentum && (
                <span
                  className={`tag ${r.momentum.classification.startsWith("CONFIRMED") ? "exact" : r.momentum.classification.endsWith("CANDIDATE") ? "estimated" : "unavailable"}`}
                  title={r.momentum.breakdown.map((b) => `${b.k}: ${b.v > 0 ? "+" : ""}${b.v.toFixed(2)}`).join("\n")}
                >
                  {r.momentum.classification.replace(/_/g, " ").toLowerCase()}
                  {r.momentum.atrMove !== null ? ` · ${Math.abs(r.momentum.atrMove).toFixed(2)}×ATR` : ""}
                </span>
              )}
              {r.rvolMode === "APPROXIMATE" && r.rvol !== null && <span className="tag approximate">rvol≈{r.rvol.toFixed(1)}</span>}
              {r.vwapPos && <span className="tag" title="Position vs provider average traded price — a session VWAP proxy, not exact trade-based VWAP">{r.vwapPos === "ABOVE" ? "above atp (vwap proxy)" : "below atp (vwap proxy)"}</span>}
              {r.futInterp && <span className="tag provider">{r.futInterp}</span>}
              {r.flow?.available && (
                <span className={`tag ${r.flow.status === "BULLISH" ? "exact" : r.flow.status === "BEARISH" ? "unavailable" : "estimated"}`} title={r.flow.reason}>
                  flow {r.flow.status.toLowerCase()} ({r.flow.attributionPct.toFixed(0)}%)
                </span>
              )}
              {r.proximity && <span className="tag oi_candidate">{r.proximity}</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
