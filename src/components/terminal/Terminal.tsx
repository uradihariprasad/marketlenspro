"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LayoutDashboard, CandlestickChart, Target, Layers, Activity, Settings2,
  LogOut, TrendingUp, RefreshCw, Crosshair, ListChecks, Newspaper, History, Scale, AlertTriangle, BarChart3, RadarIcon,
} from "lucide-react";
import Login from "./Login";
import Dashboard from "./tabs/Dashboard";
import Intelligence from "./tabs/Intelligence";
import SRMap from "./tabs/SRMap";
import Signals from "./tabs/Signals";
import OptionsDesk from "./tabs/OptionsDesk";
import OrderFlow from "./tabs/OrderFlow";
import Dominance from "./tabs/Dominance";
import OiStrikes from "./tabs/OiStrikes";
import { WatchlistTab, NewsTab, ReplayTab } from "./tabs/Extras";
import System from "./tabs/System";
import type { TerminalPayload } from "./ui";
import { QualityPill, fmtIst } from "./ui";

const TABS = [
  { id: "dashboard", label: "Overview & Scanner", short: "Overview", icon: LayoutDashboard },
  { id: "dominance", label: "Buyer/Seller Dominance", short: "Dominance", icon: Scale },
  { id: "intelligence", label: "Intelligence", short: "Intel", icon: Crosshair },
  { id: "sr", label: "S/R Map", short: "S/R", icon: CandlestickChart },
  { id: "signals", label: "Trade Finder", short: "Trades", icon: Target },
  { id: "options", label: "Options & Futures", short: "Options", icon: Layers },
  { id: "oi", label: "OI Strike Intelligence", short: "OI Strikes", icon: BarChart3 },
  { id: "flow", label: "Flow & Depth", short: "Flow", icon: Activity },
  { id: "watchlist", label: "Watchlist", short: "Watchlist", icon: ListChecks },
  { id: "replay", label: "Replay & EOD", short: "Replay", icon: History },
  { id: "news", label: "News", short: "News", icon: Newspaper },
  { id: "system", label: "System & Audit", short: "System", icon: Settings2 },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function Terminal() {
  const [payload, setPayload] = useState<TerminalPayload | null>(null);
  const [tab, setTab] = useState<TabId>("dashboard");
  // degraded read-only browsing (historical provider data, no live feed)
  const [browse, setBrowse] = useState<boolean>(
    () => typeof window !== "undefined" && sessionStorage.getItem("fno-browse") === "1"
  );
  const [instrument, setInstrumentRaw] = useState<string>("");
  const [timeframe, setTimeframe] = useState<number>(5);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusAt = useRef<string>("");

  // Selecting an instrument synchronizes every instrument-bound view and
  // re-points the server-side focus (stock chain + flow tracking). Views
  // receiving a new key clear prior state — no stale panels (rule 4.11).
  const setInstrument = useCallback((key: string) => {
    setInstrumentRaw(key);
  }, []);

  useEffect(() => {
    if (!instrument || focusAt.current === instrument) return;
    focusAt.current = instrument;
    fetch("/api/focus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instrumentKey: instrument }),
    }).catch(() => undefined);
  }, [instrument]);

  const fetchTerminal = useCallback(async () => {
    try {
      const res = await fetch("/api/terminal", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as TerminalPayload;
      setPayload(data);
      setLastFetch(Date.now());
      setFetchError(null); // recovered
      setInstrumentRaw((prev) => {
        if (prev) return prev;
        const idx = data.instruments.indices[0];
        return idx?.instrumentKey ?? "";
      });
    } catch (err) {
      // Keep the last valid payload (labelled stale below) but NEVER hide the
      // failure — an outage must not present itself as empty market panels.
      setFetchError((err as Error).message || "network error");
    }
  }, []);

  /**
   * Manual "Scan Now" — posts to the SAME coordinated pipeline the 30s
   * automatic cycle uses. Guarded so a second click cannot start a duplicate
   * scan, and the shared rate limiter still applies server-side.
   */
  const runManualScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setScanMsg(null);
    try {
      const res = await fetch("/api/scan", { method: "POST" });
      const data = (await res.json()) as { message?: string; state?: string; scan?: { evaluated: number } };
      setScanMsg(data.message ?? data.state ?? "Scan finished");
      await fetchTerminal();
    } catch {
      setScanMsg("Scan request failed — the server may be unreachable.");
    } finally {
      setScanning(false);
    }
  }, [scanning, fetchTerminal]);

  useEffect(() => {
    void fetchTerminal();
    const tick = () => {
      timer.current = setTimeout(() => {
        void fetchTerminal().then(() => tick());
      }, 9000);
    };
    tick();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [fetchTerminal]);

  if (!payload) {
    // Distinguish "still loading" from "the request is failing" — a permanent
    // spinner during an outage looks identical to a broken empty panel.
    return (
      <div className="grid min-h-screen place-items-center px-6">
        <div className="panel max-w-md p-8 text-center">
          <RefreshCw size={22} className={`mx-auto mb-4 ${fetchError ? "" : "animate-spin"} text-cyan-300`} />
          <p className="text-sm font-semibold text-slate-200">
            {fetchError ? "Cannot reach the market engine" : "Booting market engine…"}
          </p>
          <p className="mt-2 text-[12px] text-slate-500">
            {fetchError
              ? `Request failed (${fetchError}). The server may be restarting — retrying every few seconds. No market data is shown until a request succeeds, because blank panels would be misleading.`
              : "Loading the instrument universe and market state."}
          </p>
        </div>
      </div>
    );
  }

  const status = payload.status;

  // Gate: live data requires a validated Upstox token; without one, the user
  // may browse REAL historical data (charts, EOD momentum snapshot) — nothing
  // is fabricated, live panels show explicit connect states.
  if (status.tokenStatus !== "VALID" && !browse) {
    return (
      <Login
        tokenStatus={status.tokenStatus}
        onLoggedIn={() => {
          sessionStorage.removeItem("fno-browse");
          setBrowse(false);
          void fetchTerminal();
        }}
        onBrowse={() => {
          sessionStorage.setItem("fno-browse", "1");
          setBrowse(true);
        }}
      />
    );
  }

  const phaseLabel = { OPEN: "MARKET OPEN", PRE_OPEN: "PRE-OPEN", POST_CLOSE: "CLOSED", WEEKEND: "WEEKEND" }[status.marketPhase];
  const transport = status.transport;

  return (
    <div className="min-h-screen">
      {/* header */}
      <header className="sticky top-0 z-40 border-b border-slate-800/70 bg-[#05070bcc] backdrop-blur-md">
        <div className="mx-auto flex max-w-[1600px] items-center gap-2 px-3 py-2 sm:gap-4 sm:px-4 sm:py-3">
          <div className="flex min-w-0 items-center gap-2 sm:gap-2.5">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-cyan-400/30 bg-cyan-400/10">
              <TrendingUp size={16} className="text-cyan-300" />
            </div>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[11px] font-bold tracking-tight text-slate-100 sm:text-[13px]">F&amp;O INTRADAY INTELLIGENCE</div>
              <div className="hidden text-[10px] uppercase tracking-[0.18em] text-slate-500 sm:block">structure · zones · flow · options</div>
            </div>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2.5">
            {transport && (
              <span className="pill hidden text-slate-400 xl:inline-flex" title={`Market data via ${transport.mode}: quotes every ${Math.round(transport.quoteIntervalMs / 1000)}s, ${transport.cycles} cycles (${transport.failedCycles} failed), ${transport.rateLimitWaits} rate-limit waits`}>
                {transport.mode} · {Math.round(transport.quoteIntervalMs / 1000)}s · {transport.cycles} cycles
              </span>
            )}
            <span className="pill hidden text-slate-400 lg:inline-flex">
              {status.istDate} · <span className="mono text-slate-200">{status.istClock} IST</span>
            </span>
            <span className="pill" style={{ color: status.marketPhase === "OPEN" ? "var(--green)" : "var(--amber)" }}>{phaseLabel}</span>
            <QualityPill q={status.connection} />
            {/* SCAN NOW — top-right, shares the coordinated scan pipeline */}
            <button
              onClick={() => void runManualScan()}
              disabled={scanning || status.scan?.status === "RUNNING"}
              title={
                status.scan
                  ? `Last scan: ${status.scan.status.toLowerCase()}${status.scan.lastSuccessAt ? ` at ${fmtIst(status.scan.lastSuccessAt)}` : ""} · ${status.scan.evaluated} evaluated · ${status.scan.cycles} cycles`
                  : "Run an immediate scan"
              }
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-cyan-300 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50 sm:text-[11px]"
            >
              {scanning || status.scan?.status === "RUNNING" ? (
                <RefreshCw size={13} className="animate-spin" />
              ) : (
                <RadarIcon size={13} />
              )}
              <span className="hidden sm:inline">
                {scanning || status.scan?.status === "RUNNING" ? "Scanning…" : "Scan Now"}
              </span>
            </button>
            {status.tokenStatus !== "VALID" && (
              <button
                onClick={() => {
                  sessionStorage.removeItem("fno-browse");
                  setBrowse(false);
                }}
                className="rounded-lg bg-cyan-400 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-950 transition hover:bg-cyan-300"
              >
                Connect live data
              </button>
            )}
            {status.tokenStatus === "VALID" ? (
              <>
                <span className="pill hidden text-slate-400 sm:inline-flex">{status.profileName ?? "Upstox"}</span>
                <button
                  onClick={async () => {
                    await fetch("/api/auth", { method: "DELETE" });
                    setPayload(null);
                    await fetchTerminal();
                  }}
                  className="grid h-8 w-8 place-items-center rounded-lg border border-slate-700 text-slate-400 transition hover:border-rose-400/40 hover:text-rose-300"
                  title="Disconnect token"
                >
                  <LogOut size={14} />
                </button>
              </>
            ) : null}
            {lastFetch && <span className="hidden text-[10px] text-slate-600 lg:inline">sync {fmtIst(lastFetch)}</span>}
          </div>
        </div>

        {/* tabs */}
        <nav className="mx-auto hidden max-w-[1600px] items-center gap-0.5 overflow-x-auto px-4 pb-0 scroll-thin md:flex">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 whitespace-nowrap rounded-t-lg border-b-2 px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] transition ${
                  active
                    ? "border-cyan-400 bg-cyan-400/5 text-cyan-300"
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                <Icon size={14} />
                {t.label}
              </button>
            );
          })}
        </nav>
      </header>

      {/* Mobile bottom navigation: thumb-friendly, horizontally scrollable,
          and safe-area aware. Desktop keeps the complete top tab strip. */}
      <nav className="mobile-bottom-nav scroll-thin md:hidden" aria-label="Terminal sections">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={active ? "page" : undefined}
              className={`mobile-nav-item ${active ? "active" : ""}`}
            >
              <Icon size={17} />
              <span>{t.short}</span>
            </button>
          );
        })}
      </nav>

      <main className="mx-auto max-w-[1600px] px-3 py-3 pb-24 sm:px-4 sm:py-5 md:pb-5">
        {/* scan status — distinguishes fresh from cached, never silent */}
        {(scanMsg || status.scan) && (
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-[11px]">
            <span
              className={`tag ${
                status.scan?.status === "COMPLETED" ? "exact"
                : status.scan?.status === "PARTIAL" ? "estimated"
                : status.scan?.status === "RUNNING" ? "provider"
                : status.scan?.status === "IDLE" || !status.scan ? ""
                : "unavailable"
              }`}
            >
              scan {(status.scan?.status ?? "idle").toLowerCase()}
            </span>
            <span className="mono text-slate-400">
              auto every {Math.round((status.transport?.quoteIntervalMs ?? 30000) / 1000)}s
              {status.scan?.trigger ? ` · last ${status.scan.trigger.toLowerCase()}` : ""}
            </span>
            {status.scan?.lastSuccessAt && (
              <span className="mono text-slate-500">last success {fmtIst(status.scan.lastSuccessAt)}</span>
            )}
            {status.scan && status.scan.evaluated > 0 && (
              <span className="mono text-slate-500">
                {status.scan.evaluated} evaluated
                {status.scan.failed > 0 ? ` · ${status.scan.failed} stage failure(s)` : ""}
              </span>
            )}
            {status.scan?.durationMs != null && (
              <span className="mono text-slate-600">{(status.scan.durationMs / 1000).toFixed(1)}s</span>
            )}
            {scanMsg && <span className="text-slate-300">{scanMsg}</span>}
            {status.scan?.error && <span className="text-rose-300">{status.scan.error}</span>}
          </div>
        )}
        {/* an outage must be visible, never presented as empty market panels */}
        {fetchError && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-2.5 text-[12px] text-rose-200">
            <AlertTriangle size={15} className="shrink-0" />
            <span>
              <b>Live refresh failed</b> ({fetchError}). Showing the last successful snapshot from{" "}
              {lastFetch ? fmtIst(lastFetch) : "—"}, which may be stale. Retrying automatically.
            </span>
            <button
              onClick={() => void fetchTerminal()}
              className="ml-auto rounded-lg border border-rose-400/40 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider hover:bg-rose-400/10"
            >
              Retry now
            </button>
          </div>
        )}
        {status.tokenStatus !== "VALID" && (
          <div className="mb-4 flex items-center justify-between rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-[12px] text-amber-200">
            <span><b>DEGRADED HISTORICAL MODE.</b> Panels show real provider candles/EOD data only. Live quotes, scanner, chains, flow and signals need an Upstox token.</span>
            <button
              onClick={() => { sessionStorage.removeItem("fno-browse"); setBrowse(false); }}
              className="ml-4 shrink-0 rounded-lg bg-amber-400 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-950"
            >
              Enter token
            </button>
          </div>
        )}
        {tab === "dashboard" && <Dashboard payload={payload} onPick={(key) => { setInstrument(key); setTab("intelligence"); }} />}
        {tab === "dominance" && (
          <Dominance payload={payload} onPick={(key) => { setInstrument(key); setTab("intelligence"); }} />
        )}
        {tab === "intelligence" && (
          <Intelligence key={instrument} payload={payload} instrument={instrument} setInstrument={setInstrument} timeframe={timeframe} setTimeframe={setTimeframe} />
        )}
        {tab === "sr" && (
          <SRMap key={instrument} payload={payload} instrument={instrument} setInstrument={setInstrument} timeframe={timeframe} setTimeframe={setTimeframe} />
        )}
        {tab === "signals" && <Signals payload={payload} onPick={(key) => { setInstrument(key); setTab("intelligence"); }} />}
        {tab === "options" && <OptionsDesk payload={payload} />}
        {tab === "oi" && <OiStrikes payload={payload} />}
        {tab === "flow" && <OrderFlow key={instrument} payload={payload} instrument={instrument} setInstrument={setInstrument} />}
        {tab === "watchlist" && <WatchlistTab payload={payload} onPick={(key) => { setInstrument(key); setTab("intelligence"); }} />}
        {tab === "replay" && <ReplayTab payload={payload} />}
        {tab === "news" && <NewsTab />}
        {tab === "system" && <System payload={payload} />}
      </main>
    </div>
  );
}
