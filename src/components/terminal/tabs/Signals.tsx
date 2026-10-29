"use client";

import { useState } from "react";
import { Target, ChevronDown, ChevronUp, Ban, Radar } from "lucide-react";
import type { SignalPayload, TerminalPayload } from "../ui";
import { fmtNum, CapTag, fmtIst, NoteList } from "../ui";

export default function Signals({ payload, onPick }: { payload: TerminalPayload; onPick: (key: string) => void }) {
  const live = payload.signals.filter((s) => s.status === "WATCH" || s.status === "ACTIVE");
  const expired = payload.signals.filter((s) => s.status === "EXPIRED" || s.status === "INVALIDATED");
  const nameFor = (key: string) =>
    [...payload.instruments.indices, ...payload.instruments.futures, ...payload.instruments.stocks].find((i) => i.instrumentKey === key)?.label ?? key;

  return (
    <div className="fade-in space-y-4">
      <div className="panel border-slate-700/60 p-4">
        <div className="flex items-start gap-3">
          <Radar size={16} className="mt-0.5 shrink-0 text-cyan-300" />
          <div className="text-[12px] leading-relaxed text-slate-400">
            Trade candidates appear only when a defined scenario (breakout-retest, rejection reversal, failed break) satisfies every rule on a
            confirmed structure/zone with acceptable data quality. Pending confirmations are always shown. Scores are deterministic confluence
            aggregates — they are <b className="text-slate-200">not</b> calibrated win probabilities, and nothing here guarantees profitability.
          </div>
        </div>
      </div>

      {/* coverage first — an empty board must be explainable, never just blank */}
      {payload.analysisCoverage && (
        <div className="panel flex flex-wrap items-center gap-x-5 gap-y-2 p-3 text-[11px]">
          <span className="font-bold uppercase tracking-wider text-slate-400">Trade Finder coverage</span>
          <span className="mono text-slate-300">eligible {payload.analysisCoverage.eligibleStocks}</span>
          <span className="mono text-emerald-300">analysed {payload.analysisCoverage.analysedStocks}</span>
          <span className="mono text-amber-300">skipped {payload.analysisCoverage.skipped}</span>
          <span className="mono text-slate-500">{payload.analysisCoverage.perCycle} stocks/cycle + indices</span>
          <span className={`mono ${payload.analysisCoverage.freshAnalyses < payload.analysisCoverage.eligibleStocks ? "text-amber-300" : "text-emerald-300"}`}>
            {payload.analysisCoverage.fullCoverage ? "full coverage" : "rotating (partial)"}
          </span>
          <span className="mono ml-auto text-slate-500">last scan {payload.status.scanAt ? fmtIst(payload.status.scanAt) : "—"}</span>
        </div>
      )}

      {live.length === 0 && (
        <div className="panel grid place-items-center p-14 text-center">
          <Ban size={22} className="mb-3 text-slate-600" />
          <p className="text-sm font-semibold text-slate-300">No qualifying setups right now</p>
          <div className="mt-2 max-w-lg space-y-1.5 text-[12px] text-slate-500">
            <p>
              The engine does not force a trade. A candidate requires a confirmed structure/zone, a defined invalidation level and
              sufficient reward-to-risk on <b className="text-slate-300">closed</b> 5-minute bars.
            </p>
            {payload.analysisCoverage && payload.analysisCoverage.analysedStocks < payload.analysisCoverage.eligibleStocks && (
              <p className="text-amber-200/80">
                Note: only {payload.analysisCoverage.analysedStocks} of {payload.analysisCoverage.eligibleStocks} eligible stocks have
                been analysed so far (rotating {payload.analysisCoverage.perCycle} per cycle). An empty board may simply mean the
                scheduler has not reached an instrument yet — it does not mean the whole universe was checked and rejected.
              </p>
            )}
            {payload.status.tokenStatus !== "VALID" && (
              <p className="text-amber-200/80">
                No Upstox token is connected, so analysis runs on prior-session candles and every signal is labelled{" "}
                <span className="tag estimated">HISTORICAL</span>. Connect a token for live intraday scanning.
              </p>
            )}
            {expired.length > 0 && (
              <p>{expired.length} earlier setup(s) expired or were invalidated — listed below.</p>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {live.map((s) => (
          <SignalCard key={s.id} s={s} name={nameFor(s.instrumentKey)} onPick={() => onPick(s.instrumentKey)} />
        ))}
      </div>

      {expired.length > 0 && (
        <details className="panel p-4">
          <summary className="cursor-pointer text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
            Expired / invalidated ({expired.length})
          </summary>
          <div className="mt-3 space-y-1">
            {expired.slice(0, 8).map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-[11px] text-slate-500">
                <span className="tag unavailable">{s.status}</span>
                <span className="mono">{nameFor(s.instrumentKey)}</span>
                <span>{s.scenario} {s.direction}</span>
                <span className="mono ml-auto">{fmtIst(s.updatedAt)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function SignalCard({ s, name, onPick }: { s: SignalPayload; name: string; onPick: () => void }) {
  const [open, setOpen] = useState(false);
  const long = s.direction === "LONG";
  return (
    <div className={`panel panel-hover p-5 ${long ? "border-emerald-400/20" : "border-rose-400/20"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Target size={14} className={long ? "text-emerald-400" : "text-rose-400"} />
            <span className="text-[13px] font-bold tracking-wide text-slate-100">{s.scenario.replace(/_/g, " ")}</span>
            <span className={`tag ${long ? "exact" : "unavailable"}`}>{s.direction}</span>
            {s.grade && (
              <span className={`tag ${s.grade === "GOOD_TRADE" ? "exact" : "estimated"}`} title="Rule-defined decision-support category — never a win probability">
                {s.grade.replace(/_/g, " ")}
              </span>
            )}
            <span className={`tag ${s.status === "ACTIVE" ? "exact" : "estimated"}`}>{s.status}</span>
          </div>
          <button onClick={onPick} className="mt-1 text-[12px] text-cyan-300/90 underline-offset-2 hover:underline mono">{name} · {s.timeframeMin}m</button>
        </div>
        <div className="text-right">
          <div className="mono text-xl font-semibold text-slate-100">{s.score.toFixed(1)}</div>
          <div className="text-[9px] uppercase tracking-wider text-slate-500">confluence</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
        <StatCell label="Entry trigger" value={s.entry !== null ? fmtNum(s.entry) : "—"} tone={long ? "text-emerald-300" : "text-rose-300"} />
        <StatCell label="Invalidation" value={s.stop !== null ? fmtNum(s.stop) : "—"} tone="text-slate-300" />
        <StatCell label="Target 1" value={s.targets[0] !== undefined ? fmtNum(s.targets[0]) : "—"} tone="text-cyan-300" />
        <StatCell label="R:R" value={s.rr !== null ? s.rr.toFixed(2) : "—"} tone="text-slate-300" />
      </div>
      {s.targets[1] !== undefined && (
        <div className="mono mt-1 text-right text-[10px] text-slate-500">extended target {fmtNum(s.targets[1])}</div>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {s.capabilityTags.map((t) => (
          <CapTag key={t} status={t.includes("ESTIMATED") ? "estimated" : t.includes("UNAVAILABLE") ? "unavailable" : "exact"} />
        ))}
        <CapTag status={s.dataQuality === "LIVE" ? "exact" : s.dataQuality === "STALE" ? "estimated" : "provider"} />
        <span className="tag">{s.dataQuality}</span>
        <span className="mono ml-auto text-[10px] text-slate-600">valid until {fmtIst(s.validUntil)}</span>
      </div>

      <div className="mt-3 space-y-1.5">
        {s.confirmations.map((c, i) => (
          <div key={i} className="flex items-start gap-2 text-[11px] text-slate-400">
            <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
            <span>{c}</span>
          </div>
        ))}
        {s.pending.map((c, i) => (
          <div key={i} className="flex items-start gap-2 text-[11px] text-amber-200/80">
            <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
            <span>pending: {c}</span>
          </div>
        ))}
      </div>

      <p className="mt-3 border-t border-slate-800 pt-2 text-[10px] text-slate-500">
        Invalidation: {s.invalidationRule}
      </p>

      <button onClick={() => setOpen((o) => !o)} className="mt-2 flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-300">
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />} full trace & score breakdown
      </button>
      {open && (
        <div className="mt-2 grid gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Score components</p>
            {s.breakdown.map((b, i) => (
              <div key={i} className="flex justify-between text-[11px] text-slate-400">
                <span>{b.k}</span>
                <span className="mono text-slate-200">{b.v > 0 ? "+" : ""}{b.v.toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Trace inputs</p>
            <pre className="scroll-thin mono max-h-40 overflow-auto text-[10px] leading-relaxed text-slate-400">
              {JSON.stringify(s.trace.inputs, null, 1)}
            </pre>
          </div>
          <div className="sm:col-span-2">
            <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Rules evaluated</p>
            {s.trace.rules.map((r, i) => (
              <p key={i} className="text-[11px] text-slate-400">▸ {r}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCell({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2">
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mono text-[13px] font-semibold ${tone}`}>{value}</div>
    </div>
  );
}
