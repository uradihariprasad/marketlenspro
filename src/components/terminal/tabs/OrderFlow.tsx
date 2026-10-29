"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, Footprints } from "lucide-react";
import type { ChartPayload, FlowBarPayload, TerminalPayload } from "../ui";
import { fmtCnt, fmtNum, fmtIst } from "../ui";

interface FootprintPayload { barT: number; rows: { price: number; buy: number; sell: number; delta: number; imbalance: "BUY_IMBAL" | "SELL_IMBAL" | null }[] }
interface AttributionPayload {
  observations: number; attributedVol: number; unknownVol: number; totalVol: number;
  coveragePct: number; baselineVol: number | null; baselineAt: number | null;
  resets: number; gapsSkipped: number; lastObsAt: number | null; partialSession: boolean;
}
interface ConfirmPayload {
  status: string; available: boolean; reason: string;
  deltaRatio: number | null; cvdSlope: number | null; cvdNow: number | null; label: string;
  divergence: { detected: boolean; bearish: boolean; note: string } | null;
}
type FlowShape = {
  mode: string; transport?: string; reset: string; tickCount: number;
  attribution?: AttributionPayload; confirm?: ConfirmPayload;
  bars: FlowBarPayload[]; footprint: FootprintPayload | null;
} | null;

export default function OrderFlow({ payload, instrument, setInstrument }: { payload: TerminalPayload; instrument: string; setInstrument: (k: string) => void }) {
  const options = [...payload.instruments.futures, ...payload.instruments.indices];
  const [chart, setChart] = useState<ChartPayload | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const seq = useRef(0);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  const load = useCallback(async (key: string) => {
    if (!key) return;
    const id = ++seq.current;
    try {
      const res = await fetch(`/api/chart?instrumentKey=${encodeURIComponent(key)}&timeframe=5`, { cache: "no-store" });
      if (id !== seq.current) return;
      if (!res.ok) {
        setFetchErr(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as ChartPayload;
      setFetchErr(data.ok ? null : (data.error ?? "flow unavailable"));
      setChart(data);
    } catch {
      if (id === seq.current) setFetchErr("network error");
    }
  }, []);

  useEffect(() => {
    const boot = setTimeout(() => void load(instrument), 0);
    const tick = () => {
      timer.current = setTimeout(() => void load(instrument).then(tick), 15000);
    };
    tick();
    return () => {
      clearTimeout(boot);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [instrument, load]);

  const flow = (chart?.flow ?? chart?.analysis?.flow ?? null) as FlowShape;
  const bars = flow?.bars ?? [];

  const degraded = payload.status.tokenStatus !== "VALID";
  const noTicks = !flow || flow.tickCount === 0;

  return (
    <div className="fade-in space-y-4">
      {/* connection state first — capability notes second */}
      {degraded ? (
        <div className="panel flex flex-wrap items-center gap-3 border-cyan-400/25 p-5">
          <Activity size={18} className="text-cyan-300" />
          <div className="min-w-0 flex-1 text-[12px] text-slate-300">
            <b>Order flow needs a live connection.</b> You are browsing historical data. Enter your Upstox token (login screen) and this tab
            will stream ESTIMATED delta/CVD from real ticks within seconds of market activity.
          </div>
          <span className="tag unavailable">estimated flow: awaiting token</span>
        </div>
      ) : (
        <details className="panel p-3">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Why are these marked ESTIMATED? (capability disclosure)
          </summary>
          <div className="mt-2 flex items-start gap-2 text-[12px] text-slate-400">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
            <span>
              The Upstox feed carries LTP + cumulative volume but no executed-trade aggressor classification or trade ids, so trade-based
              Delta/CVD can never be exact with this provider. Values below are tick-rule estimates at stream resolution, session-reset 09:15 IST —
              a directional proxy, not exchange bid/ask prints.
            </span>
          </div>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {fetchErr && <span className="rounded-md border border-rose-400/30 bg-rose-400/5 px-2 py-1 text-[11px] text-rose-200">refresh error: {fetchErr}</span>}
        <select className="select-slim mono" value={instrument} onChange={(e) => setInstrument(e.target.value)}>
          <optgroup label="Index futures (volume-bearing — recommended)">
            {payload.instruments.futures.map((i) => (
              <option key={i.instrumentKey} value={i.instrumentKey}>{i.label}</option>
            ))}
          </optgroup>
          <optgroup label="Spot indices (no bar volume)">
            {payload.instruments.indices.map((i) => (
              <option key={i.instrumentKey} value={i.instrumentKey}>{i.label}</option>
            ))}
          </optgroup>
        </select>
        {flow && (
          <span className="mono text-[10px] text-slate-500">{flow.tickCount} observations · {flow.reset}</span>
        )}
      </div>

      {/* Honest flow status: freshness, attribution coverage, confirmation */}
      {flow?.attribution && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Instrument" value={chart?.displayName ?? "—"} />
          <Stat label="Last observation" value={flow.attribution.lastObsAt ? fmtIst(flow.attribution.lastObsAt) : "—"} />
          <Stat label="Valid observations" value={String(flow.attribution.observations)} />
          <Stat
            label="Attribution coverage"
            value={`${flow.attribution.coveragePct.toFixed(0)}%`}
            tone={flow.attribution.coveragePct >= 50 ? "text-emerald-300" : flow.attribution.coveragePct >= 20 ? "text-amber-300" : "text-rose-300"}
            hint={`${fmtCnt(flow.attribution.attributedVol)} attributed / ${fmtCnt(flow.attribution.unknownVol)} unknown`}
          />
          <Stat label="Unknown volume" value={fmtCnt(flow.attribution.unknownVol)} tone="text-slate-400" hint="volume observed but not attributable to a side — never forced into buy/sell" />
          <Stat
            label="Flow status"
            value={flow.confirm?.status ?? "—"}
            tone={flow.confirm?.status === "BULLISH" ? "text-emerald-300" : flow.confirm?.status === "BEARISH" ? "text-rose-300" : "text-slate-300"}
            hint={flow.confirm?.reason}
          />
        </div>
      )}
      {flow?.attribution && (
        <p className="text-[10px] leading-relaxed text-slate-600">
          Baseline: first cumulative-volume observation {flow.attribution.baselineVol !== null ? fmtCnt(flow.attribution.baselineVol) : "—"}
          {flow.attribution.baselineAt ? ` at ${fmtIst(flow.attribution.baselineAt)}` : ""} — recorded as a reference only and never counted as traded volume.
          {flow.attribution.resets > 0 && ` ${flow.attribution.resets} volume reset(s) re-baselined.`}
          {flow.attribution.gapsSkipped > 0 && ` ${flow.attribution.gapsSkipped} increment(s) left unattributed due to long polling gaps.`}
          {flow.attribution.partialSession && " PARTIAL SESSION: tracker started mid-session, so CVD covers only the observed window."}
        </p>
      )}

      {noTicks && !degraded && (
        <div className="panel grid place-items-center p-14 text-center">
          <Activity size={22} className="mb-3 text-slate-600" />
          <p className="text-sm font-semibold text-slate-300">No ticks received yet</p>
          <p className="mt-1 max-w-md text-[12px] text-slate-500">
            {payload.status.marketPhase !== "OPEN"
              ? "Market is closed — estimated flow accumulates from live ticks during trading hours (09:15–15:30 IST)."
              : "Collecting data — REST-polled estimated flow accumulates one observation per polling cycle (~10s). The first observation only sets a volume baseline."}
          </p>
        </div>
      )}

      {flow && bars.length > 1 && <CvdChart bars={bars} />}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* delta bars table */}
        {flow && bars.length > 0 && (
          <div className="panel overflow-hidden">
            <div className="border-b border-slate-800 p-3">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Per-bar estimated delta (5m)</h3>
              <p className="text-[10px] text-slate-600">buy − sell from tick-rule poll increments · ESTIMATED</p>
            </div>
            <div className="scroll-thin max-h-[380px] overflow-y-auto">
              <table className="tbl mono">
                <thead><tr><th>Bar (IST)</th><th className="text-right">Buy</th><th className="text-right">Sell</th><th className="text-right" title="volume observed but not attributable to a side">Unknown</th><th className="text-right">Delta</th><th className="text-right">CVD</th></tr></thead>
                <tbody>
                  {[...bars].reverse().slice(0, 40).map((b) => (
                    <tr key={b.t}>
                      <td className="text-slate-400">{fmtIst(b.t)}</td>
                      <td className="text-right text-emerald-300/80">{fmtCnt(b.buyVol)}</td>
                      <td className="text-right text-rose-300/80">{fmtCnt(b.sellVol)}</td>
                      <td className="text-right text-slate-500">{b.untracedVol ? fmtCnt(b.untracedVol) : "—"}</td>
                      <td className={`text-right font-semibold ${b.delta >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{b.delta >= 0 ? "+" : ""}{fmtCnt(b.delta)}</td>
                      <td className={`text-right ${b.cvd >= 0 ? "text-emerald-300/70" : "text-rose-300/70"}`}>{fmtCnt(b.cvd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* footprint */}
        {flow?.footprint && (
          <div className="panel overflow-hidden">
            <div className="flex items-center gap-2 border-b border-slate-800 p-3">
              <Footprints size={14} className="text-amber-300" />
              <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Estimated footprint — latest bar @ {fmtIst(flow.footprint.barT)}</h3>
            </div>
            <div className="scroll-thin max-h-[380px] overflow-y-auto">
              <table className="tbl mono">
                <thead><tr><th className="text-right">Est. Bid</th><th>Price</th><th className="text-left">Est. Ask</th><th className="text-right">Δ</th><th>Imb</th></tr></thead>
                <tbody>
                  {flow.footprint.rows.map((r) => (
                    <tr key={r.price} className={r.imbalance ? "bg-slate-800/30" : undefined}>
                      <td className="text-right text-rose-300/80">{r.sell > 0 ? fmtCnt(r.sell) : ""}</td>
                      <td className="text-center font-semibold text-slate-200">{fmtNum(r.price)}</td>
                      <td className="text-left text-emerald-300/80">{r.buy > 0 ? fmtCnt(r.buy) : ""}</td>
                      <td className={`text-right ${r.delta >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{r.delta !== 0 ? fmtCnt(r.delta) : ""}</td>
                      <td>
                        {r.imbalance === "BUY_IMBAL" && <span className="tag exact">buy ≥3×</span>}
                        {r.imbalance === "SELL_IMBAL" && <span className="tag unavailable">sell ≥3×</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-slate-800 p-2 text-[9px] text-slate-600">
              Diagonal imbalance: buy[p] vs sell[p−tick] (and mirrored), ratio ≥ 3, min volume 300. Ladder built from observed LTP levels — approximate, not exchange prints.
            </p>
          </div>
        )}

        {/* provider market depth (resting book snapshot — never used to infer trades) */}
        <div className="panel overflow-hidden lg:col-span-2">
          <div className="flex items-center gap-2 border-b border-slate-800 p-3">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Market depth — resting order book (provider snapshot)</h3>
            <span className="ml-auto text-[9px] text-slate-600">resting depth ≠ executed trades; never used for aggressor inference</span>
          </div>
          {chart?.quote && chart.quote.depthLevels > 0 ? (
            <div className="grid grid-cols-2 gap-0">
              <DepthSide label="Bids" levels={chart.quote.bids} tone="text-emerald-300" bar="rgba(52,211,153,0.35)" />
              <DepthSide label="Asks" levels={chart.quote.asks} tone="text-rose-300" bar="rgba(248,113,113,0.4)" />
            </div>
          ) : (
            <div className="p-5 text-[12px] text-slate-600">
              Depth unavailable for this instrument on the REST quote transport (indices carry no order book; equity/futures top-of-book appears in the REST quote response when the provider supplies it).
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="panel p-3" title={hint}>
      <div className="text-[9px] uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className={`mono mt-1 truncate text-[13px] font-semibold ${tone ?? "text-slate-100"}`}>{value}</div>
    </div>
  );
}

function DepthSide({ label, levels, tone, bar }: { label: string; levels: { p: number; q: number }[]; tone: string; bar: string }) {
  const max = Math.max(...levels.map((l) => l.q), 1);
  return (
    <table className="tbl mono">
      <thead><tr><th colSpan={2} className="text-slate-400">{label}</th></tr><tr><th>Price</th><th className="text-right">Qty</th></tr></thead>
      <tbody>
        {levels.slice(0, 5).map((l, i) => (
          <tr key={i} className="oi-bar-wrap">
            <td className={tone}>{fmtNum(l.p)}</td>
            <td className="text-right">
              <span className="oi-bar" style={{ width: `${(l.q / max) * 100}%`, background: bar, right: 0 }} />
              <span className="relative">{fmtCnt(l.q)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CvdChart({ bars }: { bars: FlowBarPayload[] }) {
  const w = 880;
  const h = 180;
  const pad = 8;
  const cvds = bars.map((b) => b.cvd);
  const min = Math.min(0, ...cvds);
  const max = Math.max(0, ...cvds);
  const span = Math.max(max - min, 1);
  const x = (i: number) => pad + (i / Math.max(bars.length - 1, 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const path = cvds.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${path} L${x(bars.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const last = cvds[cvds.length - 1];
  return (
    <div className="panel p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Estimated CVD — session reset</h3>
        <span className={`mono text-sm font-semibold ${last >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{fmtCnt(last)}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none" style={{ height: 180 }}>
        <defs>
          <linearGradient id="cvdg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={last >= 0 ? "#34d399" : "#f87171"} stopOpacity="0.28" />
            <stop offset="100%" stopColor="#0b0f16" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1={pad} y1={y(0)} x2={w - pad} y2={y(0)} stroke="#27344a" strokeDasharray="4 4" strokeWidth="1" />
        <path d={area} fill="url(#cvdg)" />
        <path d={path} fill="none" stroke={last >= 0 ? "#34d399" : "#f87171"} strokeWidth="1.6" />
      </svg>
      <p className="mt-1 text-[9px] text-slate-600">Warnings only: CVD divergence (if any) requires structure confirmation; see Trade Signals pending confirmations.</p>
    </div>
  );
}
