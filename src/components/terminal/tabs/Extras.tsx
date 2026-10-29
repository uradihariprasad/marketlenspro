"use client";

import { useCallback, useEffect, useState } from "react";
import { BookmarkPlus, Trash2, Newspaper, History, Play, ExternalLink } from "lucide-react";
import type { TerminalPayload } from "../ui";
import { Color, fmtNum, fmtIst, NoteList } from "../ui";

// ---------------------------------------------------------------- Watchlist

export function WatchlistTab({ payload, onPick }: { payload: TerminalPayload; onPick: (key: string) => void }) {
  const [keys, setKeys] = useState<string[]>([]);
  const [quotes, setQuotes] = useState<Record<string, { ltp: number | null; changePct: number | null; quality: string }>>({});
  const [loaded, setLoaded] = useState(false);
  const all = [...payload.instruments.indices, ...payload.instruments.futures, ...payload.instruments.stocks];
  const nameFor = (k: string) => all.find((i) => i.instrumentKey === k)?.label ?? k;

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/watchlist", { cache: "no-store" });
      const d = (await r.json()) as { keys: string[]; quotes: typeof quotes };
      setKeys(d.keys);
      setQuotes(d.quotes);
      setLoaded(true);
    } catch { /* offline tolerance */ }
  }, []);

  useEffect(() => {
    const boot = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 12000);
    return () => {
      clearTimeout(boot);
      clearInterval(t);
    };
  }, [load]);

  const save = async (next: string[]) => {
    setKeys(next);
    await fetch("/api/watchlist", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys: next }) });
  };

  const [pick, setPick] = useState("");
  const options = all.filter((i) => !keys.includes(i.instrumentKey)).slice(0, 500);

  return (
    <div className="fade-in space-y-4">
      <div className="panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[13px] font-bold uppercase tracking-[0.12em] text-slate-300">Watchlist</h2>
          <select className="select-slim mono" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Add instrument…</option>
            <optgroup label="Indices & futures">
              {[...payload.instruments.indices, ...payload.instruments.futures].map((i) => (
                <option key={i.instrumentKey} value={i.instrumentKey}>{i.label}</option>
              ))}
            </optgroup>
            <optgroup label="F&O stocks">
              {payload.instruments.stocks.map((i) => (
                <option key={i.instrumentKey} value={i.instrumentKey}>{i.label}</option>
              ))}
            </optgroup>
          </select>
          <button
            disabled={!pick || keys.includes(pick)}
            onClick={() => pick && void save([...keys, pick]).then(() => setPick(""))}
            className="flex items-center gap-1.5 rounded-lg bg-cyan-400 px-3 py-1.5 text-[11px] font-bold text-slate-950 transition hover:bg-cyan-300 disabled:opacity-40"
          >
            <BookmarkPlus size={13} /> Add
          </button>
          <span className="text-[10px] text-slate-600">persisted in PostgreSQL · max 40</span>
        </div>
      </div>

      <div className="panel overflow-hidden">
        {!loaded && <div className="p-6 text-sm text-slate-600">loading…</div>}
        {loaded && keys.length === 0 && <div className="p-6 text-sm text-slate-600">Watchlist empty — add instruments above.</div>}
        {keys.map((k) => {
          const q = quotes[k];
          return (
            <div key={k} className="scroll-thin flex min-w-0 items-center gap-3 overflow-x-auto border-b border-slate-800/60 px-3 py-2.5 transition hover:bg-slate-800/20 sm:px-4">
              <button onClick={() => onPick(k)} className="mono text-[13px] font-semibold text-slate-100 hover:text-cyan-300">{nameFor(k)}</button>
              <span className="mono text-[10px] text-slate-600">{k}</span>
              <span className="mono ml-auto text-[13px] text-slate-200">{q?.ltp !== null && q?.ltp !== undefined ? fmtNum(q.ltp) : "—"}</span>
              <span className="mono w-20 text-right text-[12px]"><Color v={q?.changePct ?? null} suffix="%" /></span>
              <span className={`tag ${q?.quality === "LIVE" ? "exact" : q?.quality === "STALE" ? "estimated" : "unavailable"}`}>{q?.quality ?? "…"}</span>
              <button onClick={() => void save(keys.filter((x) => x !== k))} className="text-slate-600 transition hover:text-rose-300" aria-label={`Remove ${nameFor(k)}`}>
                <Trash2 size={14} />
              </button>
              <span className="hidden">{void options}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- News

export function NewsTab() {
  const [data, setData] = useState<{ available: boolean; items: { title: string; link: string; pubDate: string; source: string }[]; errors: string[] } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/news", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => alive && setData(d))
      .catch(() => alive && setData({ available: false, items: [], errors: ["fetch failed"] }));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="fade-in space-y-4">
      <div className="panel p-4">
        <h2 className="text-[13px] font-bold uppercase tracking-[0.12em] text-slate-300">News &amp; Events</h2>
        <p className="mt-1 text-[11px] text-slate-500">Real headlines from public market RSS feeds (Moneycontrol, ET Markets), refreshed server-side every 2 minutes. No fabricated items — if feeds are unreachable, this panel shows UNAVAILABLE.</p>
      </div>
      {!data && <div className="panel p-6 text-sm text-slate-600">loading…</div>}
      {data && !data.available && (
        <div className="panel grid place-items-center p-14 text-center">
          <Newspaper size={22} className="mb-3 text-slate-600" />
          <p className="text-sm font-semibold text-slate-300">News feeds unavailable</p>
          <p className="mt-1 text-[12px] text-slate-500">{data.errors.join(" · ") || "No feed responded."}</p>
        </div>
      )}
      {data?.available && (
        <div className="panel divide-y divide-slate-800/60">
          {data.items.map((n, i) => (
            <a key={i} href={n.link} target="_blank" rel="noreferrer noopener" className="flex items-start gap-3 px-4 py-3 transition hover:bg-slate-800/20">
              <Newspaper size={14} className="mt-0.5 shrink-0 text-slate-500" />
              <div className="min-w-0">
                <p className="text-[13px] leading-snug text-slate-200">{n.title}</p>
                <p className="mt-0.5 text-[10px] text-slate-600">
                  {n.source} · {n.pubDate ? new Date(n.pubDate).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—"}
                </p>
              </div>
              <ExternalLink size={12} className="ml-auto mt-1 shrink-0 text-slate-600" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ Replay & EOD

interface ReplayResponse {
  ok: boolean;
  error?: string;
  date?: string;
  replay?: {
    sessionDate: string;
    barsReplayed: number;
    zonesAtEnd: number;
    notes: string[];
    steps: { t: number; signals: { id: string; scenario: string; direction: string; score: number; entry: number | null }[] }[];
    signals: { id: string; scenario: string; direction: "LONG" | "SHORT"; firstSeenAt: number; entry: number | null; stop: number | null; targets: number[]; score: number; grade: string; outcome: string; outcomeDetail: string }[];
  };
}

export function ReplayTab({ payload }: { payload: TerminalPayload }) {
  const options = [...payload.instruments.indices, ...payload.instruments.futures, ...payload.instruments.stocks];
  const [instrument, setInstrument] = useState(options[0]?.instrumentKey ?? "");
  const [tf, setTf] = useState(5);
  const [date, setDate] = useState("");
  const [res, setRes] = useState<ReplayResponse | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!instrument) return;
    setBusy(true);
    setRes(null);
    try {
      const params = new URLSearchParams({ instrumentKey: instrument, timeframe: String(tf) });
      if (date) params.set("date", date);
      const r = await fetch(`/api/replay?${params}`, { cache: "no-store" });
      setRes((await r.json()) as ReplayResponse);
    } catch {
      setRes({ ok: false, error: "request failed" });
    } finally {
      setBusy(false);
    }
  }

  const rp = res?.replay;
  const counts = rp
    ? {
        tp: rp.signals.filter((s) => s.outcome === "TP1").length,
        sl: rp.signals.filter((s) => s.outcome === "SL").length,
        open: rp.signals.filter((s) => s.outcome === "OPEN" || s.outcome === "EOD").length,
      }
    : null;

  return (
    <div className="fade-in space-y-4">
      <div className="panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <History size={15} className="text-violet-300" />
          <h2 className="text-[13px] font-bold uppercase tracking-[0.12em] text-slate-300">Historical Replay &amp; EOD Analytics</h2>
          <select className="select-slim mono" value={instrument} onChange={(e) => setInstrument(e.target.value)}>
            {options.slice(0, 500).map((i) => (
              <option key={i.instrumentKey} value={i.instrumentKey}>{i.label}</option>
            ))}
          </select>
          <input type="date" className="select-slim mono" value={date} onChange={(e) => setDate(e.target.value)} />
          <div className="flex overflow-hidden rounded-lg border border-slate-700">
            {[5, 15].map((t) => (
              <button key={t} onClick={() => setTf(t)} className={`px-3 py-1.5 text-[11px] font-bold ${tf === t ? "bg-violet-400/15 text-violet-300" : "text-slate-500"}`}>{t}m</button>
            ))}
          </div>
          <button onClick={() => void run()} disabled={busy || !instrument} className="flex items-center gap-1.5 rounded-lg bg-violet-400 px-3 py-1.5 text-[11px] font-bold text-slate-950 transition hover:bg-violet-300 disabled:opacity-40">
            <Play size={13} /> {busy ? "Replaying…" : "Run replay"}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Each replay step recomputes structure, zones and candidates using ONLY bars closed strictly before that step — no look-ahead by construction.
          Outcomes are descriptive replay statistics (target vs invalidation within the session), not a performance promise.
        </p>
      </div>

      {res && !res.ok && <div className="panel p-5 text-sm text-rose-300">{res.error} {res.date ? `(${res.date})` : ""}</div>}

      {rp && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Chip label="Session" value={rp.sessionDate} />
            <Chip label="Bars replayed" value={String(rp.barsReplayed)} />
            <Chip label="Unique candidates" value={String(rp.signals.length)} />
            <Chip label="T1 reached / invalidated / open" value={counts ? `${counts.tp} / ${counts.sl} / ${counts.open}` : "—"} />
          </div>
          <div className="panel overflow-hidden">
            <div className="scroll-thin max-h-[420px] overflow-y-auto">
              <table className="tbl mono">
                <thead><tr><th>First seen (IST)</th><th>Scenario</th><th>Dir</th><th>Grade</th><th className="text-right">Score</th><th className="text-right">Entry</th><th className="text-right">Stop</th><th className="text-right">T1</th><th>Outcome</th></tr></thead>
                <tbody>
                  {rp.signals.length === 0 && (
                    <tr><td colSpan={9} className="py-8 text-center text-slate-600">No qualifying setups in this session — the engine did not force trades.</td></tr>
                  )}
                  {rp.signals.map((s) => (
                    <tr key={s.id}>
                      <td className="text-slate-400">{fmtIst(s.firstSeenAt)}</td>
                      <td className="text-slate-200">{s.scenario.replace(/_/g, " ")}</td>
                      <td><span className={`tag ${s.direction === "LONG" ? "exact" : "unavailable"}`}>{s.direction}</span></td>
                      <td><span className={`tag ${s.grade === "GOOD_TRADE" ? "exact" : "estimated"}`}>{s.grade?.replace(/_/g, " ") ?? "—"}</span></td>
                      <td className="text-right text-cyan-300">{s.score.toFixed(1)}</td>
                      <td className="text-right">{fmtNum(s.entry, 1)}</td>
                      <td className="text-right">{fmtNum(s.stop, 1)}</td>
                      <td className="text-right">{fmtNum(s.targets[0] ?? null, 1)}</td>
                      <td>
                        <span className={`tag ${s.outcome === "TP1" ? "exact" : s.outcome === "SL" ? "unavailable" : "provider"}`}>{s.outcome}</span>
                        <span className="ml-1 text-[10px] text-slate-500">{s.outcomeDetail}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <NoteList notes={rp.notes} />
        </>
      )}
    </div>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel p-3">
      <div className="text-[9px] uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className="mono mt-1 text-[15px] font-semibold text-slate-100">{value}</div>
    </div>
  );
}
