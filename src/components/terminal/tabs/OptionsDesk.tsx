"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layers, Info, Search, Loader2 } from "lucide-react";
import type { ChainPayload, ChainResponse, TerminalPayload } from "../ui";
import { Color, fmtCnt, fmtNum, fmtIst, NoteList } from "../ui";

/**
 * Options Desk — indices AND F&O stocks.
 *
 * Capability comes from the instrument master (underlyings that actually have
 * listed contracts), so unsupported instruments are never offered. The chain
 * itself is fetched per selected instrument via /api/chain, keeping the
 * terminal payload small.
 */
export default function OptionsDesk({ payload }: { payload: TerminalPayload }) {
  const catalog = useMemo(() => payload.chainCatalog ?? [], [payload.chainCatalog]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [expiry, setExpiry] = useState<string>("");
  const [res, setRes] = useState<ChainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  // default to the first index underlying once the catalog arrives
  useEffect(() => {
    if (!selected && catalog.length > 0) {
      const idx = catalog.find((c) => c.isIndex) ?? catalog[0];
      setSelected(idx.underlyingKey);
    }
  }, [catalog, selected]);

  const load = useCallback(async (key: string) => {
    if (!key) return;
    const id = ++seq.current;
    setLoading(true);
    try {
      const r = await fetch(`/api/chain?instrumentKey=${encodeURIComponent(key)}`, { cache: "no-store" });
      if (id !== seq.current) return;
      setRes((await r.json()) as ChainResponse);
    } catch {
      if (id === seq.current) setRes({ ok: false, state: "FAILED", underlyingKey: key, symbol: key, error: "network error" });
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const boot = setTimeout(() => void load(selected), 0);
    const t = setInterval(() => void load(selected), 20000);
    return () => { clearTimeout(boot); clearInterval(t); };
  }, [selected, load]);

  const filtered = query.trim()
    ? catalog.filter((c) => c.symbol.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 60)
    : catalog.slice(0, 60);
  const chain: ChainPayload | undefined = res?.ok ? res.chain : undefined;
  const expiries = res?.expiries ?? catalog.find((c) => c.underlyingKey === selected)?.expiries ?? [];
  const stats = payload.chainStats;

  return (
    <div className="fade-in space-y-4">
      {/* selector */}
      <div className="panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Layers size={15} className="text-violet-300" />
          <h2 className="text-[13px] font-bold uppercase tracking-[0.12em] text-slate-300">Option Desk</h2>
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              className="token-input !w-56 !py-1.5 !pl-7 !text-[12px]"
              placeholder="Search NIFTY, RELIANCE…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <select className="select-slim mono w-full sm:w-auto sm:max-w-[260px]" value={selected} onChange={(e) => setSelected(e.target.value)}>
            <optgroup label="Indices">
              {filtered.filter((c) => c.isIndex).map((c) => (
                <option key={c.underlyingKey} value={c.underlyingKey}>{c.symbol}</option>
              ))}
            </optgroup>
            <optgroup label="F&O stocks (listed option contracts)">
              {filtered.filter((c) => !c.isIndex).map((c) => (
                <option key={c.underlyingKey} value={c.underlyingKey}>{c.symbol}</option>
              ))}
            </optgroup>
          </select>
          {expiries.length > 0 && (
            <select className="select-slim mono" value={expiry || chain?.expiry || expiries[0]} onChange={(e) => setExpiry(e.target.value)}>
              {expiries.map((x) => (<option key={x} value={x}>{x}</option>))}
            </select>
          )}
          {loading && <Loader2 size={14} className="animate-spin text-slate-500" />}
          {stats && (
            <span className="mono ml-auto text-[10px] text-slate-500">
              chains: {stats.loaded} loaded · {stats.pending} pending · {stats.failed} failed · {stats.total} with contracts
            </span>
          )}
        </div>
        {expiry && chain && expiry !== chain.expiry && (
          <p className="mt-2 text-[11px] text-amber-200/80">
            Showing the scheduler&rsquo;s nearest expiry <b>{chain.expiry}</b>. Selecting {expiry} queues it for the next cycle.
          </p>
        )}
      </div>

      {/* non-loaded states are explicit, never a blank table */}
      {!chain && res && (
        <div className="panel grid place-items-center p-14 text-center">
          <Layers size={22} className="mb-3 text-slate-600" />
          <p className="text-sm font-semibold text-slate-300">
            {res.state === "UNSUPPORTED" ? "No option chain for this instrument"
              : res.state === "REQUIRES_TOKEN" ? "Option chain requires an Upstox token"
              : res.state === "FAILED" ? "Chain request failed"
              : "Chain loading"}
          </p>
          <p className="mt-1 max-w-lg text-[12px] text-slate-500">{res.error ?? res.note ?? "queued for the next scheduler cycle"}</p>
          <span className={`tag mt-3 ${res.state === "LOADED" ? "exact" : res.state === "PENDING" ? "estimated" : "unavailable"}`}>{res.state}</span>
        </div>
      )}

      {chain && (
        <>
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Underlying" value={res?.symbol ?? "—"} />
            <StatCard label="Spot" value={fmtNum(chain.spot, 2)} />
            <StatCard label="PCR (OI)" value={chain.pcrOi !== null ? chain.pcrOi.toFixed(2) : "—"} hint="Σ PE OI ÷ Σ CE OI" />
            <StatCard label="PCR (Volume)" value={chain.pcrVol !== null ? chain.pcrVol.toFixed(2) : "—"} hint="never mixed with OI PCR" />
            <StatCard label="Max Pain" value={chain.maxPain !== null ? fmtNum(chain.maxPain, 0) : "—"} />
            <StatCard label="Captured" value={fmtIst(chain.capturedAt)} hint={`age ${Math.round((res?.ageMs ?? 0) / 1000)}s`} />
          </div>

          <div className="panel overflow-hidden">
            <div className="flex items-center gap-2 border-b border-slate-800 p-3">
              <Layers size={14} className="text-violet-300" />
              <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">
                {res?.symbol} · expiry {chain.expiry} · ATM ± 12
              </h3>
              <span className="mono ml-auto text-[10px] text-slate-500">
                ΔOI vs session reference {chain.refCapturedAt ? `captured ${fmtIst(chain.refCapturedAt)}` : "(pending)"}
              </span>
            </div>
            <div className="scroll-thin overflow-x-auto">
              <table className="tbl mono">
                <thead>
                  <tr>
                    <th className="text-right" title="OI change vs session&rsquo;s first snapshot">CE ΔOI sess</th>
                    <th className="text-right" title="OI change vs previous snapshot (~20s)">CE ΔOI prev</th>
                    <th className="text-right">Call OI</th>
                    <th className="text-right">Call Vol</th>
                    <th className="text-right">CE LTP</th>
                    <th className="text-right">CE IV</th>
                    <th>Strike</th>
                    <th className="text-right">PE IV</th>
                    <th className="text-right">PE LTP</th>
                    <th className="text-right">Put Vol</th>
                    <th className="text-right">Put OI</th>
                    <th className="text-right" title="OI change vs previous snapshot (~20s)">PE ΔOI prev</th>
                    <th className="text-right" title="OI change vs session&rsquo;s first snapshot">PE ΔOI sess</th>
                  </tr>
                </thead>
                <tbody>
                  {chain.rows.map((r) => (
                    <ChainRow key={r.strike} r={r} chain={chain} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel border-slate-700/60 p-4">
            <div className="flex items-start gap-2 text-[11px] text-slate-500">
              <Info size={13} className="mt-0.5 shrink-0 text-blue-300" />
              <div>
                <NoteList notes={chain.notes} />
                <p className="mt-1">▸ High Call OI is contextual, not guaranteed resistance; high Put OI is contextual, not guaranteed support. Missing provider fields stay blank — never zero-filled.</p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ChainRow({ r, chain }: { r: ChainPayload["rows"][number]; chain: ChainPayload }) {
  const maxOi = Math.max(...chain.rows.map((x) => Math.max(x.ceOi, x.peOi)), 1);
  const maxChg = Math.max(...chain.rows.map((x) => Math.max(Math.abs(x.ceOiChg ?? 0), Math.abs(x.peOiChg ?? 0))), 1);
  const isAtm = r.strike === chain.atmStrike;
  const isMaxPain = r.strike === chain.maxPain;
  return (
    <tr className={isAtm ? "bg-cyan-400/[0.07]" : undefined}>
      <DeltaCell v={r.ceOiChg} max={maxChg} color="rgba(248,113,113,0.5)" />
      <td className="text-right text-[10px]">{prevTxt(r.ceOiChgPrev)}</td>
      <OICell v={r.ceOi} max={maxOi} color="rgba(248,113,113,0.45)" />
      <td className="text-right text-slate-500">{fmtCnt(r.ceVol)}</td>
      <td className="text-right text-slate-300">{fmtNum(r.ceLtp, 2)}</td>
      <td className="text-right text-slate-500">{r.ceIv !== null ? r.ceIv.toFixed(1) : "—"}</td>
      <td className="text-center font-bold text-slate-100">
        {fmtNum(r.strike, 0)}
        {isAtm && <span className="tag provider ml-1">ATM</span>}
        {isMaxPain && <span className="tag estimated ml-1">MP</span>}
      </td>
      <td className="text-right text-slate-500">{r.peIv !== null ? r.peIv.toFixed(1) : "—"}</td>
      <td className="text-right text-slate-300">{fmtNum(r.peLtp, 2)}</td>
      <td className="text-right text-slate-500">{fmtCnt(r.peVol)}</td>
      <OICell v={r.peOi} max={maxOi} color="rgba(52,211,153,0.45)" />
      <td className="text-right text-[10px]">{prevTxt(r.peOiChgPrev)}</td>
      <DeltaCell v={r.peOiChg} max={maxChg} color="rgba(52,211,153,0.5)" />
    </tr>
  );
}

function prevTxt(v: number | null | undefined) {
  if (v === null || v === undefined) return <span className="text-slate-700">—</span>;
  return <span className={v > 0 ? "text-emerald-300/70" : v < 0 ? "text-rose-300/70" : "text-slate-500"}>{v > 0 ? "+" : ""}{fmtCnt(v)}</span>;
}

function OICell({ v, max, color }: { v: number; max: number; color: string }) {
  return (
    <td className="oi-bar-wrap text-right">
      <span className="oi-bar" style={{ width: `${Math.min(100, (v / max) * 100)}%`, background: color, right: 0 }} />
      <span className="relative">{fmtCnt(v)}</span>
    </td>
  );
}

function DeltaCell({ v, max, color }: { v: number | null; max: number; color: string }) {
  if (v === null) return <td className="text-right text-slate-600">—</td>;
  return (
    <td className="oi-bar-wrap text-right">
      <span className="oi-bar" style={{ width: `${Math.min(100, (Math.abs(v) / max) * 100)}%`, background: v >= 0 ? color : "rgba(148,163,184,0.35)", right: 0 }} />
      <span className={`relative ${v >= 0 ? "text-slate-200" : "text-slate-500"}`}>{v >= 0 ? "+" : ""}{fmtCnt(v)}</span>
    </td>
  );
}

function StatCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="panel p-3" title={hint}>
      <div className="text-[9px] uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className={`mono mt-1 truncate text-lg font-semibold ${tone ?? "text-slate-100"}`}>{value}</div>
    </div>
  );
}

void Color;
