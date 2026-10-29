"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MapPin, Layers3, ShieldAlert, Loader2 } from "lucide-react";
import PriceChart from "../PriceChart";
import type { ChartPayload, TerminalPayload, ZonePayload } from "../ui";
import { fmtNum, fmtIst, NoteList } from "../ui";

const TF_OPTIONS = [1, 2, 5, 10, 15, 30];

export default function SRMap({
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
      if (id !== seq.current) return; // ignore stale responses after selection change
      if (!res.ok) {
        setFetchErr(`chart API HTTP ${res.status}`);
        setChart((c) => c); // preserve last valid chart; flag the failed refresh
        return;
      }
      const data = (await res.json()) as ChartPayload;
      setFetchErr(data.ok ? null : (data.error ?? "chart analysis failed"));
      setChart(data);
    } catch (err) {
      if (id === seq.current) setFetchErr(`network: ${(err as Error).name}`);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Remounts on instrument change (key prop in Terminal) — never shows a previous instrument's panels
    void load(instrument, timeframe);
    const tick = () => {
      timer.current = setTimeout(() => void load(instrument, timeframe).then(tick), 20000);
    };
    tick();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [instrument, timeframe, load]);

  const a = chart?.analysis ?? null;
  const closedCount = a?.candles.filter((c) => c.closed).length ?? 0;

  return (
    <div className="fade-in space-y-4">
      {/* controls */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          className="select-slim mono w-full sm:w-auto sm:max-w-[320px]"
          value={instrument}
          onChange={(e) => setInstrument(e.target.value)}
        >
          <optgroup label="Indices">
            {payload.instruments.indices.map((i) => (
              <option key={i.instrumentKey} value={i.instrumentKey}>{i.label}</option>
            ))}
          </optgroup>
          <optgroup label="Index futures (volume-enabled)">
            {payload.instruments.futures.map((i) => (
              <option key={i.instrumentKey} value={i.instrumentKey}>{i.label}</option>
            ))}
          </optgroup>
          <optgroup label="F&O stocks">
            {payload.instruments.stocks.map((i) => (
              <option key={i.instrumentKey} value={i.instrumentKey}>{i.label}</option>
            ))}
          </optgroup>
        </select>

        <div className="flex overflow-hidden rounded-lg border border-slate-700">
          {TF_OPTIONS.map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`px-3 py-1.5 text-[11px] font-bold transition ${timeframe === tf ? "bg-cyan-400/15 text-cyan-300" : "text-slate-500 hover:text-slate-300"}`}
            >
              {tf}m
            </button>
          ))}
        </div>

        {chart?.displayName && (
          <span className="text-[12px] font-semibold text-slate-300">{chart.displayName}</span>
        )}
        {a && (
          <span className="pill" style={{ color: a.quality === "LIVE" ? "var(--green)" : a.quality === "HISTORICAL" ? "var(--blue)" : a.quality === "STALE" ? "var(--amber)" : "var(--red)" }}>
            <span className={`dot ${a.quality === "LIVE" ? "live" : a.quality === "STALE" ? "stale" : "off"}`} />
            {a.quality}
          </span>
        )}
        {loading && <Loader2 size={14} className="animate-spin text-slate-500" />}
      </div>

      {/* chart status strip — failures are always visible, never a silent blank */}
      {(loading || fetchErr) && (
        <div className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[11px] ${fetchErr ? "border-rose-400/30 bg-rose-400/5 text-rose-200" : "border-slate-700 text-slate-400"}`}>
          {loading && <Loader2 size={12} className="animate-spin" />}
          {fetchErr ? <span>Refresh error: {fetchErr} {a ? "(displaying last valid chart — labelled stale)" : ""}</span> : <span>fetching chart…</span>}
        </div>
      )}

      {/* chart */}
      <div className="panel p-3">
        {a && a.candles.length > 3 ? (
          <PriceChart
            candles={a.candles}
            ema21={a.indicators.ema21}
            vwap={a.indicators.vwap}
            zones={a.zones}
            markers={a.structure}
            profile={a.profile}
            unifiedSR={chart?.unifiedSR ?? null}
          />
        ) : (
          <div className="grid h-[360px] place-items-center px-6 text-center text-sm">
            {loading ? (
              <span className="text-slate-500">loading candles…</span>
            ) : fetchErr ? (
              <div className="space-y-1">
                <p className="font-semibold text-rose-300">Chart data request failed</p>
                <p className="mono text-[11px] text-rose-200/70">{fetchErr}</p>
                <p className="text-[11px] text-slate-500">
                  {a?.candles.length ? "Components too sparse for analysis — history hydrates in the background." : "Provider returned no candles for this instrument/timeframe — visible, not hidden."}
                </p>
              </div>
            ) : a && a.candles.length > 0 ? (
              <span className="text-slate-500">insufficient history ({a.candles.length} bars) — waiting for more data, gaps are never filled with fabricated candles</span>
            ) : (
              <span className="text-slate-600">No candle data for this instrument right now — nothing is fabricated.</span>
            )}
          </div>
        )}
        {a && a.quality !== "LIVE" && (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-slate-700/70 bg-slate-900/50 px-3 py-1.5 text-[11px] text-slate-400">
            <span className={`tag ${a.quality === "HISTORICAL" ? "provider" : "unavailable"}`}>{a.quality}</span>
            <span>
              Showing the last available session from provider candle history.
              {payload.status.tokenStatus !== "VALID"
                ? " Live ticks + indicators over today require an Upstox token — use “Enter token” in the banner above."
                : payload.status.marketPhase !== "OPEN"
                  ? " Market is closed — live updates resume 09:15 IST on trading days."
                  : " Waiting for the next live tick (freshness gate: 25s)."}
            </span>
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-slate-500">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm bg-emerald-400" /> structural support zone</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm bg-rose-400" /> structural resistance zone</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm bg-violet-400" /> OI-only candidate (dashed mid)</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm bg-amber-400" /> POC / value area (approx)</span>
          <span className="mono ml-auto">{closedCount} closed · {a?.candles.length ?? 0} total bars</span>
        </div>
      </div>

      {/* UNIFIED S/R SUMMARY — same server output the chart renders */}
      {chart?.unifiedSR && (
        <div className="panel p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Unified Support &amp; Resistance</h3>
            <span className="mono text-[10px] text-slate-500">spot {fmtNum(chart.unifiedSR.spot, 2)} · updated {fmtIst(chart.unifiedSR.updatedAt)}</span>
            <span className="ml-auto text-[9px] text-slate-600">✓ price-confirmed · ◌ OI-only candidate</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {([
              ["Primary Resistance", chart.unifiedSR.primaryResistance],
              ["Immediate Resistance", chart.unifiedSR.immediateResistance],
              ["Immediate Support", chart.unifiedSR.immediateSupport],
              ["Primary Support", chart.unifiedSR.primarySupport],
            ] as const).map(([label, lv]) => (
              <div key={label} className={`rounded-lg border p-2.5 ${lv ? (lv.side === "SUPPORT" ? "border-emerald-400/30 bg-emerald-400/5" : "border-rose-400/30 bg-rose-400/5") : "border-slate-800 bg-slate-900/40"}`}>
                <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
                {!lv ? (
                  <div className="mt-1 text-[11px] text-slate-600">
                    {label.includes("Support")
                      ? chart.unifiedSR!.unavailable.support ?? "unavailable"
                      : chart.unifiedSR!.unavailable.resistance ?? "unavailable"}
                  </div>
                ) : (
                  <>
                    <div className="mono mt-0.5 text-[15px] font-semibold text-slate-100">
                      {fmtNum(lv.price, 1)} <span className="text-[10px] text-slate-500">{lv.priceConfirmed ? "✓" : "◌"}</span>
                    </div>
                    <div className="mono text-[9px] text-slate-500">
                      {lv.lower !== lv.upper ? `${fmtNum(lv.lower, 1)}–${fmtNum(lv.upper, 1)} · ` : ""}{lv.distancePct > 0 ? "+" : ""}{lv.distancePct.toFixed(2)}%
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <span className={`tag ${lv.state.includes("STRONG") ? "exact" : lv.state.includes("STRENGTHENING") ? "approximate" : lv.state.includes("RISK") || lv.state.includes("WEAKENING") ? "unavailable" : "estimated"}`}>
                        {lv.state.replace(/_/g, " ").toLowerCase()}
                      </span>
                      <span className={`tag ${lv.provenance === "CONFLUENCE" ? "exact" : lv.provenance === "STRUCTURAL" ? "structural" : "oi_candidate"}`}>
                        {lv.provenance.toLowerCase()}
                      </span>
                      <span className="tag">score {lv.score.toFixed(0)}</span>
                    </div>
                    {lv.contributingStrikes.length > 0 && (
                      <p className="mono mt-1 text-[9px] text-slate-600">strikes {lv.contributingStrikes.join(", ")}</p>
                    )}
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[9px] uppercase tracking-wider text-slate-500">evidence</summary>
                      <div className="mt-1 space-y-0.5">
                        {lv.evidence.slice(0, 8).map((ev, i) => (
                          <div key={i} className="flex justify-between gap-2 text-[9px]">
                            <span className="text-slate-500">{ev.k}</span>
                            <span className={`mono shrink-0 ${ev.weight > 0 ? "text-emerald-300/70" : ev.weight < 0 ? "text-rose-300/70" : "text-slate-600"}`}>
                              {ev.weight > 0 ? "+" : ""}{ev.weight.toFixed(0)}
                            </span>
                          </div>
                        ))}
                        {lv.evidence.slice(0, 4).map((ev, i) => (
                          <p key={`d${i}`} className="text-[9px] leading-snug text-slate-600">▸ {ev.detail}</p>
                        ))}
                      </div>
                    </details>
                    <p className="mt-1 text-[9px] text-slate-600">Invalidation: {lv.invalidation}</p>
                  </>
                )}
              </div>
            ))}
          </div>
          <NoteList notes={chart.unifiedSR.notes} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* zones table */}
        <div className="panel overflow-hidden lg:col-span-2">
          <div className="flex items-center gap-2 border-b border-slate-800 p-3">
            <MapPin size={14} className="text-cyan-300" />
            <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Dynamic Support / Resistance Zones</h3>
            <span className="ml-auto text-[10px] text-slate-600">score = confluence, not probability</span>
          </div>
          <div className="scroll-thin max-h-[420px] overflow-x-auto overflow-y-auto">
            <table className="tbl mono">
              <thead>
                <tr>
                  <th>Side</th><th>Zone</th><th>Provenance</th><th>Status</th><th>State</th>
                  <th className="text-right">Score</th><th className="text-right">Reactions</th><th className="text-right">Invalidation</th>
                </tr>
              </thead>
              <tbody>
                {(a?.zones ?? []).map((z) => (
                  <ZoneRow key={z.id} z={z} />
                ))}
                {a && a.zones.length === 0 && (
                  <tr><td colSpan={8} className="py-6 text-center text-slate-600">No zones qualified for this timeframe yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* profile + session levels */}
        <div className="space-y-4">
          <div className="panel p-4">
            <div className="mb-3 flex items-center gap-2">
              <Layers3 size={14} className="text-amber-300" />
              <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Volume Profile (session)</h3>
            </div>
            {a?.profile ? (
              <div className="space-y-2 text-[12px] mono">
                <Row k="Mode" v={<span className="tag approximate">{a.profile.mode}</span>} />
                <Row k="POC" v={fmtNum(a.profile.poc)} />
                <Row k="VAH" v={fmtNum(a.profile.vah)} />
                <Row k="VAL" v={fmtNum(a.profile.val)} />
                <Row k="HVN nodes" v={a.profile.hvn.map((x) => fmtNum(x, 0)).join("  ") || "—"} small />
                <Row k="LVN nodes" v={a.profile.lvn.map((x) => fmtNum(x, 0)).join("  ") || "—"} small />
                <p className="pt-2 text-[10px] leading-relaxed text-slate-500">Reference zones, not guaranteed S/R. Approximate allocation (triangular at typical price) — detail in System tab.</p>
              </div>
            ) : (
              <p className="text-[12px] text-slate-600">Volume profile unavailable (no bar volume on this instrument). Try the corresponding index futures contract.</p>
            )}
          </div>

          <div className="panel p-4">
            <div className="mb-2 flex items-center gap-2">
              <ShieldAlert size={14} className="text-violet-300" />
              <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Notes & data quality</h3>
            </div>
            <NoteList notes={a?.notes ?? []} />
            {a?.range && (
              <p className="mt-2 text-[11px] text-slate-500">
                Range: {a.range.active ? "consolidating" : "not consolidating"} across last {a.range.bars} bars ({fmtNum(a.range.low, 1)}–{fmtNum(a.range.high, 1)}).
              </p>
            )}
            <p className="mt-2 text-[10px] text-slate-600 mono">last sync {a ? fmtIst(Date.now()) : "—"}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ZoneRow({ z }: { z: ZonePayload }) {
  const [open, setOpen] = useState(false);
  const reactions = z.touches.filter((t) => t.reaction !== "PASS").length;
  return (
    <>
      <tr className="cursor-pointer" onClick={() => setOpen((o) => !o)}>
        <td>
          <span className={`tag ${z.side === "SUPPORT" ? "exact" : z.side === "RESISTANCE" ? "unavailable" : "provider"}`}>{z.side}</span>
        </td>
        <td>{fmtNum(z.lower, 1)} – {fmtNum(z.upper, 1)}<span className="text-slate-500"> · mid {fmtNum(z.mid, 1)}</span></td>
        <td>
          <span className={`tag ${z.provenanceGroup === "STRUCTURAL" ? "structural" : "oi_candidate"}`}>
            {z.provenanceGroup === "STRUCTURAL" ? "structural" : "OI-only"}
          </span>
          {z.provenanceGroup === "OI_CANDIDATE" && z.confirmationStatus === "CONFIRMED" && <span className="tag approximate ml-1">price-confirmed</span>}
          {z.provenanceGroup === "STRUCTURAL" && z.confirmationStatus === "CONFIRMED" && <span className="tag exact ml-1">confirmed</span>}
        </td>
        <td className="text-slate-400">{z.state}</td>
        <td className="text-slate-400">{z.confirmationStatus}</td>
        <td className="text-right text-cyan-300">{z.score.toFixed(1)}</td>
        <td className="text-right">{reactions}/{z.touches.length}</td>
        <td className="text-right text-rose-300">{fmtNum(z.invalidation, 1)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} className="bg-slate-900/40">
            <div className="grid gap-3 p-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Score components</p>
                {z.breakdown.map((b, i) => (
                  <div key={i} className="flex justify-between text-[11px] text-slate-400">
                    <span>{b.k}</span><span className="mono text-slate-300">+{b.v.toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div>
                <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Sources</p>
                {z.sources.map((s, i) => (
                  <div key={i} className="text-[11px] text-slate-400">
                    <span className="tag mr-1">{s.kind}</span>
                    {s.detail}
                    {s.t && <span className="mono ml-1 text-slate-600">@ {new Date(s.t).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}</span>}
                  </div>
                ))}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function Row({ k, v, small }: { k: string; v: React.ReactNode; small?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-slate-500">{k}</span>
      <span className={`${small ? "text-[10px]" : ""} text-slate-200`}>{v}</span>
    </div>
  );
}
