"use client";

/**
 * Selected Stock Intelligence (Phase 4.10/4.11) — one instrument, one
 * timestamp: live quote, indicators, structure zones, profile, estimated
 * flow, futures/option positioning and active scenario candidates rendered
 * from the SAME /api/chart response (no pieced-together stale state).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Crosshair, Loader2 } from "lucide-react";
import PriceChart from "../PriceChart";
import type { ChartPayload, TerminalPayload } from "../ui";
import { Color, fmtCnt, fmtNum, fmtIst, CapTag, QualityPill, NoteList } from "../ui";

export default function Intelligence({
  payload, instrument, setInstrument, timeframe, setTimeframe,
}: {
  payload: TerminalPayload;
  instrument: string;
  setInstrument: (s: string) => void;
  timeframe: number;
  setTimeframe: (n: number) => void;
}) {
  const [chart, setChart] = useState<ChartPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (key: string, tf: number) => {
    if (!key) return;
    const id = ++seq.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/chart?instrumentKey=${encodeURIComponent(key)}&timeframe=${tf}`, { cache: "no-store" });
      if (id !== seq.current) return;
      if (!res.ok) {
        setFetchErr(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as ChartPayload;
      setFetchErr(data.ok ? null : (data.error ?? "analysis failed"));
      setChart(data);
    } catch (err) {
      if (id === seq.current) setFetchErr(`network: ${(err as Error).name}`);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Parent remounts this view via key={instrument} on selection change — no stale panels
    void load(instrument, timeframe);
    const tick = () => {
      timer.current = setTimeout(() => void load(instrument, timeframe).then(tick), 15000);
    };
    tick();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [instrument, timeframe, load]);

  const a = chart?.analysis ?? null;
  const q = chart?.quote ?? null;
  const chain = chart?.chain ?? null;
  const flow = chart?.flow ?? null;
  const sigs = payload.signals.filter((s) => s.instrumentKey === instrument && (s.status === "WATCH" || s.status === "ACTIVE"));
  const lastBar = flow?.bars[flow.bars.length - 1];

  const selector = (
    <select className="select-slim mono w-full sm:w-auto sm:max-w-[300px]" value={instrument} onChange={(e) => setInstrument(e.target.value)}>
      <optgroup label="Indices">{payload.instruments.indices.map((i) => <option key={i.instrumentKey} value={i.instrumentKey}>{i.label}</option>)}</optgroup>
      <optgroup label="Index futures">{payload.instruments.futures.map((i) => <option key={i.instrumentKey} value={i.instrumentKey}>{i.label}</option>)}</optgroup>
      <optgroup label="F&O stocks">{payload.instruments.stocks.map((i) => <option key={i.instrumentKey} value={i.instrumentKey}>{i.label}</option>)}</optgroup>
    </select>
  );

  return (
    <div className="fade-in space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Crosshair size={15} className="text-cyan-300" />
        <h2 className="text-[13px] font-bold uppercase tracking-[0.12em] text-slate-300">Selected Instrument Intelligence</h2>
        {selector}
        <div className="flex overflow-hidden rounded-lg border border-slate-700">
          {[1, 2, 5, 10, 15, 30].map((tf) => (
            <button key={tf} onClick={() => setTimeframe(tf)} className={`px-2.5 py-1 text-[10px] font-bold ${timeframe === tf ? "bg-cyan-400/15 text-cyan-300" : "text-slate-500"}`}>{tf}m</button>
          ))}
        </div>
        {loading && <Loader2 size={14} className="animate-spin text-slate-500" />}
        {fetchErr && <span className="rounded-md border border-rose-400/30 bg-rose-400/5 px-2 py-0.5 text-[10px] text-rose-200">refresh error: {fetchErr}</span>}
        {chart && <span className="mono ml-auto text-[10px] text-slate-600">as of {fmtIst(chart.asOf ?? Date.now())} · one shared snapshot</span>}
      </div>

      {/* quote strip */}
      <div className="panel p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="text-[15px] font-bold text-slate-100">{chart?.displayName ?? "—"}</span>
          <span className="mono text-xl font-semibold text-slate-100">{q?.ltp !== null && q?.ltp !== undefined ? fmtNum(q.ltp) : "—"}</span>
          <Color v={q?.changePct ?? null} suffix="%" />
          {a && <QualityPill q={a.quality} />}
          {a && a.quality !== "LIVE" && (
            <span className="text-[11px] text-slate-500">
              {payload.status.tokenStatus !== "VALID"
                ? "historical snapshot — enter a token for live updates"
                : payload.status.marketPhase !== "OPEN"
                  ? "market closed — live updates resume next session"
                  : "awaiting live tick freshness"}
            </span>
          )}
          {q && q.atp !== null && (
            <span className="text-[11px] text-slate-500">
              ATP (VWAP proxy, provider) <span className="mono text-slate-300">{fmtNum(q.atp)}</span> — {q.ltp !== null && q.ltp >= q.atp! ? "price ABOVE" : "price BELOW"}
            </span>
          )}
          {q && q.oi !== null && <span className="text-[11px] text-slate-500">OI <span className="mono text-slate-300">{fmtCnt(q.oi)}</span></span>}
          {q && q.volumeCum !== null && <span className="text-[11px] text-slate-500">Vol <span className="mono text-slate-300">{fmtCnt(q.volumeCum)}</span></span>}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* chart */}
        <div className="panel p-3 xl:col-span-2">
          {a && a.candles.length > 10 ? (
            <PriceChart candles={a.candles} ema21={a.indicators.ema21} vwap={a.indicators.vwap} zones={a.zones} markers={a.structure} profile={a.profile} unifiedSR={chart?.unifiedSR ?? null} height={380} />
          ) : (
            <div className="grid h-[380px] place-items-center text-sm text-slate-600">{loading ? "loading…" : "no candle data available"}</div>
          )}
        </div>

        {/* metrics column */}
        <div className="space-y-4">
          <div className="panel p-4">
            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Indicators (computed, closed bars)</h3>
            <div className="grid grid-cols-2 gap-2 text-[12px] mono">
              <Metric k="RSI 14" v={fmtNum(last(a?.indicators.rsi14))} />
              <Metric k="ATR 14" v={fmtNum(last(a?.indicators.atr14))} />
              <Metric k="EMA 9" v={fmtNum(last(a?.indicators.ema9))} />
              <Metric k="EMA 21" v={fmtNum(last(a?.indicators.ema21))} />
              <Metric k="EMA 50" v={fmtNum(last(a?.indicators.ema50))} />
              <Metric k="VWAP (session)" v={fmtNum(last(a?.indicators.vwap))} />
            </div>
          </div>

          <div className="panel p-4">
            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">CVD momentum (ESTIMATED)</h3>
            {chart?.cvd && chart.cvd.mode === "ESTIMATED" ? (
              <>
                <div className="grid grid-cols-2 gap-2 text-[12px] mono">
                  <Metric k="State" v={<span className={`tag ${chart.cvd.state.startsWith("STRONG") ? "exact" : chart.cvd.state.startsWith("WEAKENING") ? "estimated" : "approximate"}`}>{chart.cvd.state.replace(/_/g, " ").toLowerCase()}</span>} />
                  <Metric k="Normalised Δ" v={chart.cvd.normalizedDelta !== null ? `${chart.cvd.normalizedDelta.toFixed(0)}%` : "—"} />
                  <Metric k="Session CVD" v={fmtCnt(chart.cvd.cvdNow)} />
                  <Metric k="CVD slope" v={chart.cvd.cvdSlope !== null ? fmtCnt(chart.cvd.cvdSlope) : "—"} />
                  <Metric k="Δ acceleration" v={chart.cvd.deltaAcceleration !== null ? (chart.cvd.deltaAcceleration > 0 ? "building" : chart.cvd.deltaAcceleration < 0 ? "fading" : "flat") : "—"} />
                  <Metric k="Δ consistency" v={chart.cvd.deltaConsistency !== null ? `${(chart.cvd.deltaConsistency * 100).toFixed(0)}%` : "—"} />
                </div>
                {!chart.cvd.priceAgrees && (
                  <p className="mt-2 text-[10px] text-amber-200/80">Price has not confirmed the flow direction in this window.</p>
                )}
                {chart.cvd.divergence?.detected && (
                  <p className="mt-1 text-[10px] text-rose-200/80">{chart.cvd.divergence.note}</p>
                )}
                {chart.flowSource?.isProxy && (
                  <p className="mt-2 rounded-lg border border-violet-400/25 bg-violet-400/5 px-2.5 py-1.5 text-[10px] text-violet-200/90">
                    <b>Flow source:</b> {chart.flowSource.sourceLabel ?? chart.flowSource.sourceKey}
                    {chart.flowSource.contractExpiry ? ` (expiry ${chart.flowSource.contractExpiry})` : ""} — this spot index
                    reports no traded volume, so Delta/CVD are derived from that index-futures contract. Spot price, candles and
                    S/R remain spot-based and are never blended with futures volume.
                  </p>
                )}
                {!chart.flowSource?.isProxy && chart.flowSource && (
                  <p className="mt-2 text-[9px] text-slate-600">Flow source: {chart.flowSource.sourceType.replace(/_/g, " ").toLowerCase()} — {chart.flowSource.reason}</p>
                )}
                <p className="mt-2 text-[9px] text-slate-600">{chart.cvd.basis}</p>
              </>
            ) : (
              <p className="text-[12px] text-slate-600">Unavailable — needs live quote polling to accumulate Delta/CVD observations.</p>
            )}
          </div>

          <div className="panel p-4">
            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Order flow (ESTIMATED)</h3>
            {flow && lastBar ? (
              <div className="grid grid-cols-2 gap-2 text-[12px] mono">
                <Metric k="CVD (session)" v={fmtCnt(lastBar.cvd)} />
                <Metric k="Δ last bar" v={fmtCnt(lastBar.delta)} />
                <Metric k="Mode" v={<CapTag status="estimated" />} />
                <Metric k="Ticks" v={String((flow as { tickCount?: number }).tickCount ?? flow.bars.length)} />
              </div>
            ) : (
              <p className="text-[12px] text-slate-600">Unavailable — REST-polled estimated flow needs live quote polling (token + open market).</p>
            )}
            {flow && <p className="mt-2 text-[9px] text-slate-600">{flow.reset}</p>}
          </div>

          <div className="panel p-4">
            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Volume profile (session)</h3>
            {a?.profile ? (
              <div className="grid grid-cols-3 gap-2 text-[12px] mono">
                <Metric k="POC" v={fmtNum(a.profile.poc, 1)} />
                <Metric k="VAH" v={fmtNum(a.profile.vah, 1)} />
                <Metric k="VAL" v={fmtNum(a.profile.val, 1)} />
              </div>
            ) : (
              <p className="text-[12px] text-slate-600">Unavailable for this instrument type (no bar volume).</p>
            )}
          </div>

          <div className="panel p-4">
            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Option positioning</h3>
            {chain ? (
              <div className="grid grid-cols-2 gap-2 text-[12px] mono">
                <Metric k="Expiry" v={chain.expiry} />
                <Metric k="ATM" v={fmtNum(chain.atmStrike, 0)} />
                <Metric k="PCR (OI)" v={chain.pcrOi !== null ? chain.pcrOi.toFixed(2) : "—"} />
                <Metric k="PCR (Vol)" v={chain.pcrVol !== null ? chain.pcrVol.toFixed(2) : "—"} />
                <Metric k="Max pain" v={fmtNum(chain.maxPain, 0)} />
                <Metric k="Ref snapshot" v={chain.refCapturedAt ? fmtIst(chain.refCapturedAt) : "pending"} />
              </div>
            ) : (
              <p className="text-[12px] text-slate-600">
                {payload.status.tokenStatus === "VALID"
                  ? "Chain fetch pending (60s cadence) or not applicable for this instrument."
                  : "Requires a valid Upstox token."}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* scenarios for this instrument */}
      <div className="panel p-4">
        <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Active scenario candidates (this instrument)</h3>
        {sigs.length === 0 && <p className="text-[12px] text-slate-600">None — no scenario satisfies its conditions on this instrument right now.</p>}
        <div className="grid gap-2 md:grid-cols-2">
          {sigs.map((s) => (
            <div key={s.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
              <div className="flex items-center gap-2 text-[12px]">
                <span className={`tag ${s.direction === "LONG" ? "exact" : "unavailable"}`}>{s.direction}</span>
                <span className="font-semibold text-slate-200">{s.scenario.replace(/_/g, " ")}</span>
                {s.grade && <span className={`tag ${s.grade === "GOOD_TRADE" ? "exact" : "estimated"}`}>{s.grade.replace(/_/g, " ")}</span>}
                <span className="mono ml-auto text-cyan-300">{s.score.toFixed(1)}</span>
              </div>
              <div className="mono mt-1.5 text-[11px] text-slate-400">
                entry {fmtNum(s.entry)} · stop {fmtNum(s.stop)} · T1 {fmtNum(s.targets[0] ?? null)}{s.targets[1] ? ` · T2 ${fmtNum(s.targets[1])}` : ""} · R:R {s.rr?.toFixed(2) ?? "—"}
              </div>
              {s.pending.length > 0 && <div className="mt-1 text-[10px] text-amber-200/80">pending: {s.pending.join("; ")}</div>}
            </div>
          ))}
        </div>
      </div>

      <NoteList notes={a?.notes ?? []} />
    </div>
  );
}

function last(arr: (number | null)[] | undefined): number | null {
  if (!arr) return null;
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null && arr[i] !== undefined) return arr[i];
  return null;
}

function Metric({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{k}</div>
      <div className="text-slate-200">{v}</div>
    </div>
  );
}
