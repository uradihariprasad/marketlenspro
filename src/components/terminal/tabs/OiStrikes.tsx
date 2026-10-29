"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Loader2, AlertTriangle, Crosshair, Info } from "lucide-react";
import type { TerminalPayload } from "../ui";
import { fmtCnt, fmtNum, fmtIst, NoteList } from "../ui";

// ---- view types mirroring the OI intelligence engine output
interface StrikeDelta {
  strike: number;
  ceChange: number | null; peChange: number | null;
  ceChangePct: number | null; peChangePct: number | null;
  ceOi: number | null; peOi: number | null;
}
interface OiWindow {
  label: string; windowMs: number; status: "OK" | "COLLECTING" | "UNAVAILABLE";
  reason: string; baselineAt: number | null; currentAt: number | null;
  actualSpanMs: number | null; rows: StrikeDelta[];
}
interface TotalOiRow { strike: number; ceOi: number | null; peOi: number | null }
interface Posture { strike: number; side: "CE" | "PE"; posture: string; oiChange: number; premiumChange: number | null; note: string }
interface OiZone {
  strike: number; kind: "SUPPORT" | "RESISTANCE"; classification: string;
  provenance: string; confirmation: string; score: number;
  evidence: { k: string; v: string }[]; contributingStrikes: number[]; invalidation: string;
}
interface OiPayload {
  underlyingKey: string; symbol: string; expiry: string; spot: number | null;
  atmStrike: number | null; focusStrikes: number[]; strikeInterval: number | null;
  ladder: number[]; capturedAt: number;
  windows: { w5: OiWindow; w15: OiWindow; session: OiWindow };
  totalOi: TotalOiRow[];
  totals: { ceOi: number; peOi: number; pcrOi: number | null };
  concentration: { topCallStrikes: TotalOiRow[]; topPutStrikes: TotalOiRow[] };
  postures: Posture[];
  momentum: { state: string; reasons: string[]; agreement: string; exhaustionEvidence: string[] };
  zones: { primarySupport: OiZone | null; primaryResistance: OiZone | null; all: OiZone[] };
  history: { observations: number; spanMs: number; firstAt: number | null; lastAt: number | null };
  dataQuality: { status: string; ageMs: number | null; notes: string[] };
}
interface OiResponse { ok: boolean; state: string; error?: string; oi?: OiPayload; tokenStatus?: string }

export default function OiStrikes({ payload }: { payload: TerminalPayload }) {
  const catalog = useMemo(() => payload.chainCatalog ?? [], [payload.chainCatalog]);
  const [selected, setSelected] = useState("");
  const [res, setRes] = useState<OiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<number>(10); // strikes either side of ATM
  const seq = useRef(0);

  useEffect(() => {
    if (!selected && catalog.length > 0) {
      setSelected((catalog.find((c) => c.isIndex) ?? catalog[0]).underlyingKey);
    }
  }, [catalog, selected]);

  const load = useCallback(async (key: string) => {
    if (!key) return;
    const id = ++seq.current;
    setLoading(true);
    try {
      const r = await fetch(`/api/oi?instrumentKey=${encodeURIComponent(key)}`, { cache: "no-store" });
      if (id !== seq.current) return;
      setRes((await r.json()) as OiResponse);
    } catch {
      if (id === seq.current) setRes({ ok: false, state: "FAILED", error: "network error" });
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const boot = setTimeout(() => void load(selected), 0);
    const t = setInterval(() => void load(selected), 20000);
    return () => { clearTimeout(boot); clearInterval(t); };
  }, [selected, load]);

  const oi = res?.ok ? res.oi : undefined;
  const entry = catalog.find((c) => c.underlyingKey === selected);

  // Visible ladder slice centred on ATM (full ladder remains available).
  const visible = useMemo(() => {
    if (!oi) return [];
    const i = oi.atmStrike !== null ? oi.ladder.indexOf(oi.atmStrike) : -1;
    if (i < 0) return oi.ladder;
    return oi.ladder.slice(Math.max(0, i - range), Math.min(oi.ladder.length, i + range + 1));
  }, [oi, range]);

  return (
    <div className="fade-in space-y-4">
      {/* controls */}
      <div className="panel p-4">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <BarChart3 size={15} className="text-cyan-300" />
          <h2 className="text-[13px] font-bold uppercase tracking-[0.12em] text-slate-300">OI Strike Intelligence</h2>
          <select className="select-slim mono w-full sm:w-auto sm:max-w-[240px]" value={selected} onChange={(e) => setSelected(e.target.value)}>
            <optgroup label="Indices">
              {catalog.filter((c) => c.isIndex).map((c) => (<option key={c.underlyingKey} value={c.underlyingKey}>{c.symbol}</option>))}
            </optgroup>
            <optgroup label="F&O stocks">
              {catalog.filter((c) => !c.isIndex).slice(0, 250).map((c) => (<option key={c.underlyingKey} value={c.underlyingKey}>{c.symbol}</option>))}
            </optgroup>
          </select>
          {entry && entry.expiries.length > 0 && (
            <span className="pill text-slate-400" title="expiry currently fetched by the chain scheduler">
              expiry {oi?.expiry ?? entry.expiries[0]}
            </span>
          )}
          <div className="flex overflow-hidden rounded-lg border border-slate-700">
            {[5, 10, 20].map((n) => (
              <button key={n} onClick={() => setRange(n)} className={`px-2.5 py-1.5 text-[10px] font-bold ${range === n ? "bg-cyan-400/15 text-cyan-300" : "text-slate-500"}`}>
                ATM±{n}
              </button>
            ))}
            <button onClick={() => setRange(999)} className={`px-2.5 py-1.5 text-[10px] font-bold ${range === 999 ? "bg-cyan-400/15 text-cyan-300" : "text-slate-500"}`}>
              Full
            </button>
          </div>
          {loading && <Loader2 size={14} className="animate-spin text-slate-500" />}
          {oi && (
            <span className="mono ml-auto text-[10px] text-slate-500">
              spot {fmtNum(oi.spot, 2)} · ATM {oi.atmStrike ?? "—"} · {oi.ladder.length} strikes · {oi.history.observations} obs · {fmtIst(oi.capturedAt)}
            </span>
          )}
        </div>
        {oi && (
          <p className="mt-2 text-[10px] text-slate-600">
            ATM ±3 is highlighted as a focus band ({oi.focusStrikes.join(", ") || "—"}); analysis always covers the complete ladder.
            Strike interval {oi.strikeInterval ?? "—"} read from live contract data.
          </p>
        )}
      </div>

      {/* non-loaded states */}
      {res && !oi && (
        <div className="panel grid place-items-center p-12 text-center">
          <AlertTriangle size={22} className="mb-3 text-amber-400" />
          <p className="text-sm font-semibold text-slate-300">
            {res.state === "UNSUPPORTED" ? "No listed option contracts"
              : res.state === "REQUIRES_TOKEN" ? "OI data requires an Upstox token"
              : res.state === "PENDING" ? "Option chain queued"
              : "Request failed"}
          </p>
          <p className="mt-1 max-w-lg text-[12px] text-slate-500">{res.error}</p>
          <span className={`tag mt-3 ${res.state === "PENDING" ? "estimated" : "unavailable"}`}>{res.state}</span>
        </div>
      )}

      {oi && (
        <>
          {/* FOUR CHARTS */}
          <div className="grid gap-4 xl:grid-cols-2">
            <DeltaChart title="1 · 5-Minute Change in OI" w={oi.windows.w5} strikes={visible} focus={oi.focusStrikes} atm={oi.atmStrike} spot={oi.spot} />
            <DeltaChart title="2 · 15-Minute Change in OI" w={oi.windows.w15} strikes={visible} focus={oi.focusStrikes} atm={oi.atmStrike} spot={oi.spot} />
            <DeltaChart title="3 · Total Change in OI Today" w={oi.windows.session} strikes={visible} focus={oi.focusStrikes} atm={oi.atmStrike} spot={oi.spot} />
            <TotalChart title="4 · Total Current OI" rows={oi.totalOi} strikes={visible} focus={oi.focusStrikes} atm={oi.atmStrike} spot={oi.spot} />
          </div>

          {/* INTERPRETATION PANEL */}
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="panel p-4 lg:col-span-2">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Crosshair size={14} className="text-cyan-300" />
                <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">Interpretation</h3>
                <span className={`tag ${oi.momentum.state.includes("STRENGTHENING") ? "exact" : oi.momentum.state.includes("EXHAUSTION") || oi.momentum.state === "CONFLICTING_OI_SIGNALS" ? "unavailable" : "estimated"}`}>
                  {oi.momentum.state.replace(/_/g, " ").toLowerCase()}
                </span>
                <span className={`tag ${oi.momentum.agreement === "ALIGNED" ? "exact" : oi.momentum.agreement === "CONFLICTING" ? "unavailable" : "estimated"}`}>
                  windows {oi.momentum.agreement.toLowerCase()}
                </span>
                <span className={`tag ${oi.dataQuality.status === "LIVE" ? "exact" : "estimated"}`}>{oi.dataQuality.status}</span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px] mono sm:grid-cols-4">
                <KV k="Spot" v={fmtNum(oi.spot, 2)} />
                <KV k="ATM" v={String(oi.atmStrike ?? "—")} />
                <KV k="PCR (OI)" v={oi.totals.pcrOi !== null ? oi.totals.pcrOi.toFixed(2) : "—"} />
                <KV k="Total CE / PE OI" v={`${fmtCnt(oi.totals.ceOi)} / ${fmtCnt(oi.totals.peOi)}`} />
                <KV k="Primary support" v={oi.zones.primarySupport ? `${oi.zones.primarySupport.strike} (${oi.zones.primarySupport.classification.toLowerCase()})` : "none established"} />
                <KV k="Primary resistance" v={oi.zones.primaryResistance ? `${oi.zones.primaryResistance.strike} (${oi.zones.primaryResistance.classification.toLowerCase()})` : "none established"} />
                <KV k="Top call OI" v={oi.concentration.topCallStrikes.slice(0, 2).map((s) => s.strike).join(", ") || "—"} />
                <KV k="Top put OI" v={oi.concentration.topPutStrikes.slice(0, 2).map((s) => s.strike).join(", ") || "—"} />
              </div>

              <div className="mt-3">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Evidence</p>
                {oi.momentum.reasons.map((r, i) => (<p key={i} className="text-[11px] text-slate-400">▸ {r}</p>))}
                {oi.momentum.exhaustionEvidence.length > 0 && (
                  <div className="mt-2 rounded-lg border border-amber-400/25 bg-amber-400/5 p-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-amber-300">Weakening / exhaustion evidence</p>
                    {oi.momentum.exhaustionEvidence.map((r, i) => (<p key={i} className="text-[11px] text-amber-200/90">▸ {r}</p>))}
                  </div>
                )}
              </div>

              {oi.postures.length > 0 && (
                <div className="mt-3">
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Positioning near ATM (5m window)</p>
                  <div className="scroll-thin max-h-44 overflow-y-auto">
                    {oi.postures.map((p, i) => (
                      <div key={i} className="flex flex-wrap items-baseline gap-2 border-b border-slate-800/50 py-1 text-[11px]">
                        <span className="mono w-16 text-slate-200">{p.strike}</span>
                        <span className={`tag ${p.side === "CE" ? "unavailable" : "exact"}`}>{p.side}</span>
                        <span className="tag estimated">{p.posture.replace(/POSSIBLE_/, "").replace(/_/g, " ").toLowerCase()}</span>
                        <span className="mono text-slate-500">ΔOI {p.oiChange > 0 ? "+" : ""}{fmtCnt(p.oiChange)}</span>
                        <span className="min-w-0 flex-1 text-slate-500">{p.note}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="mt-3 border-t border-slate-800 pt-2 text-[10px] text-slate-500">
                An OI signal alone is not a trade. Entry, invalidation, targets and reward-to-risk remain the Trade Finder&rsquo;s responsibility.
              </p>
            </div>

            {/* zones */}
            <div className="panel p-4">
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">OI-derived candidate zones</h3>
              <p className="mb-2 text-[10px] text-slate-600">
                Candidates only — OI concentration cannot establish a price-confirmed level. The price-based S/R engine remains the authority.
              </p>
              <div className="scroll-thin max-h-[360px] space-y-2 overflow-y-auto">
                {oi.zones.all.length === 0 && <p className="text-[12px] text-slate-600">No significant OI concentration resolved yet.</p>}
                {oi.zones.all.map((z) => (
                  <div key={`${z.kind}${z.strike}`} className="rounded-lg border border-slate-800 bg-slate-900/40 p-2">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className={`tag ${z.kind === "SUPPORT" ? "exact" : "unavailable"}`}>{z.kind}</span>
                      <span className="mono font-semibold text-slate-100">{z.strike}</span>
                      <span className="tag oi_candidate">{z.classification.replace(/_/g, " ").toLowerCase()}</span>
                      <span className="mono ml-auto text-cyan-300">{z.score.toFixed(0)}</span>
                    </div>
                    <div className="mt-1 space-y-0.5">
                      {z.evidence.map((ev, i) => (
                        <div key={i} className="flex justify-between gap-2 text-[10px] text-slate-500">
                          <span>{ev.k}</span><span className="mono text-slate-400">{ev.v}</span>
                        </div>
                      ))}
                    </div>
                    <p className="mt-1 text-[9px] text-slate-600">Invalidation: {z.invalidation}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="panel border-slate-700/60 p-4">
            <div className="flex items-start gap-2">
              <Info size={13} className="mt-0.5 shrink-0 text-blue-300" />
              <NoteList notes={oi.dataQuality.notes} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Diverging CE/PE bar chart for a change window. */
function DeltaChart({
  title, w, strikes, focus, atm, spot,
}: { title: string; w: OiWindow; strikes: number[]; focus: number[]; atm: number | null; spot: number | null }) {
  const rows = w.rows.filter((r) => strikes.includes(r.strike));
  const max = Math.max(...rows.flatMap((r) => [Math.abs(r.ceChange ?? 0), Math.abs(r.peChange ?? 0)]), 1);

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 p-3">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">{title}</h3>
        <Legend />
        <span className="mono ml-auto text-[9px] text-slate-500">
          {w.status === "OK" && w.actualSpanMs !== null
            ? `actual span ${Math.round(w.actualSpanMs / 1000)}s · baseline ${fmtIst(w.baselineAt)}`
            : w.status}
        </span>
      </div>
      {w.status !== "OK" ? (
        <div className="grid h-[260px] place-items-center px-6 text-center text-[12px] text-slate-500">
          <div>
            <p className="font-semibold text-slate-400">{w.status === "COLLECTING" ? "Collecting observations" : "Unavailable"}</p>
            <p className="mt-1">{w.reason}</p>
            <p className="mt-1 text-[10px] text-slate-600">No value is shown until a genuine baseline observation exists.</p>
          </div>
        </div>
      ) : (
        <div className="scroll-thin max-h-[300px] overflow-y-auto p-2">
          {rows.map((r) => {
            const isFocus = focus.includes(r.strike);
            const isAtm = r.strike === atm;
            return (
              <div key={r.strike} className={`flex items-center gap-1.5 rounded px-1 py-[3px] ${isAtm ? "bg-cyan-400/10" : isFocus ? "bg-slate-700/20" : ""}`}>
                <span className={`mono w-14 shrink-0 text-right text-[10px] ${isAtm ? "font-bold text-cyan-300" : isFocus ? "text-slate-200" : "text-slate-500"}`}>
                  {r.strike}{isAtm ? " ◄" : ""}
                </span>
                <Bars ce={r.ceChange} pe={r.peChange} max={max} cePct={r.ceChangePct} pePct={r.peChangePct} diverging />
              </div>
            );
          })}
          {spot !== null && <p className="mono mt-2 px-1 text-[9px] text-slate-600">underlying spot {fmtNum(spot, 2)} · ATM highlighted ◄</p>}
        </div>
      )}
    </div>
  );
}

/** Absolute CE/PE OI bars. */
function TotalChart({
  title, rows, strikes, focus, atm, spot,
}: { title: string; rows: TotalOiRow[]; strikes: number[]; focus: number[]; atm: number | null; spot: number | null }) {
  const vis = rows.filter((r) => strikes.includes(r.strike));
  const max = Math.max(...vis.flatMap((r) => [r.ceOi ?? 0, r.peOi ?? 0]), 1);
  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 p-3">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-300">{title}</h3>
        <Legend />
        <span className="mono ml-auto text-[9px] text-slate-500">open contracts — not volume</span>
      </div>
      <div className="scroll-thin max-h-[300px] overflow-y-auto p-2">
        {vis.map((r) => {
          const isFocus = focus.includes(r.strike);
          const isAtm = r.strike === atm;
          return (
            <div key={r.strike} className={`flex items-center gap-1.5 rounded px-1 py-[3px] ${isAtm ? "bg-cyan-400/10" : isFocus ? "bg-slate-700/20" : ""}`}>
              <span className={`mono w-14 shrink-0 text-right text-[10px] ${isAtm ? "font-bold text-cyan-300" : isFocus ? "text-slate-200" : "text-slate-500"}`}>
                {r.strike}{isAtm ? " ◄" : ""}
              </span>
              <Bars ce={r.ceOi} pe={r.peOi} max={max} />
            </div>
          );
        })}
        {spot !== null && <p className="mono mt-2 px-1 text-[9px] text-slate-600">underlying spot {fmtNum(spot, 2)}</p>}
      </div>
    </div>
  );
}

function Bars({
  ce, pe, max, cePct, pePct, diverging,
}: { ce: number | null; pe: number | null; max: number; cePct?: number | null; pePct?: number | null; diverging?: boolean }) {
  const pxCe = Math.min(100, (Math.abs(ce ?? 0) / max) * 100);
  const pxPe = Math.min(100, (Math.abs(pe ?? 0) / max) * 100);
  const title = (label: string, v: number | null, p?: number | null) =>
    v === null ? `${label}: unavailable` : `${label}: ${v > 0 ? "+" : ""}${Math.round(v)}${p != null ? ` (${p > 0 ? "+" : ""}${p.toFixed(1)}%)` : ""}`;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div className="flex h-3.5 min-w-0 flex-1 justify-end overflow-hidden rounded-sm bg-slate-900/60" title={title("CE", ce, cePct)}>
        <div
          className={`h-full ${diverging && (ce ?? 0) < 0 ? "bg-rose-400/35" : "bg-rose-400/70"}`}
          style={{ width: `${pxCe}%` }}
        />
      </div>
      <span className="mono w-14 shrink-0 text-center text-[9px] text-slate-500">
        {ce === null && pe === null ? "n/a" : ""}
      </span>
      <div className="flex h-3.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-slate-900/60" title={title("PE", pe, pePct)}>
        <div
          className={`h-full ${diverging && (pe ?? 0) < 0 ? "bg-emerald-400/35" : "bg-emerald-400/70"}`}
          style={{ width: `${pxPe}%` }}
        />
      </div>
    </div>
  );
}

function Legend() {
  return (
    <span className="flex items-center gap-2 text-[9px] text-slate-500">
      <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-rose-400/70" /> CALL</span>
      <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-emerald-400/70" /> PUT</span>
      <span className="text-slate-600">(faded = unwinding)</span>
    </span>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-wider text-slate-500">{k}</div>
      <div className="truncate text-slate-200">{v}</div>
    </div>
  );
}
