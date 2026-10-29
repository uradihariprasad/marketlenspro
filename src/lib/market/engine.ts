/**
 * Ingestion & orchestration engine (server-side singleton).
 *
 * Responsibilities (Part B + Part C/G pipelines):
 *  - Token lifecycle: validated at login, stored server-side only (settings
 *    table), 401 → EXPIRED, never exposed to the client.
 *  - Instrument master refresh (bounded retry / exponential backoff+jitter).
 *  - Quote polling (~8s) with freshness-based quality labels; counters kept.
 *  - Option chain polling (~60s) for index underlyings with timestamped
 *    session-reference snapshots persisted to PostgreSQL.
 *  - Historical candle hydration + session cache, per-timeframe analysis
 *    (structure → S/R → profile → order-flow context → indicators).
 *  - Signal board: scenario engine on 5-minute structure for index
 *    instruments; persisted with full trace; expired when data degrades.
 *  - All data-dependent outputs carry a quality state:
 *    LIVE / STALE / PARTIAL / UNAVAILABLE / HISTORICAL (rule 7).
 */

import { db } from "@/db";
import { settings as settingsTable, oiSnapshots, zones as zonesTable, signals as signalsTable, alerts as alertsTable } from "@/db/schema";
import { sql, eq, desc } from "drizzle-orm";
import {
  Candle, Quote, DataQuality, ChartAnalysis, Signal,
  buildCapabilityMatrix, marketPhase, istDateKey, istParts,
  sessionElapsedFraction, round4,
} from "./types";
import type { ScannerRow } from "./scanner";
import {
  loadUniverse, validateToken, fetchQuotes, fetchHistoricalCandles,
  fetchIntradayCandles, fetchOptionContracts, fetchOptionChain,
  pickNearestExpiry, Universe, UpstoxError, UpstoxProfile,
} from "./upstox";
import { inSession, dedupeSort, resample, bySession, gapReport, lastClosed } from "./candles";
import { analyzeStructure } from "./structure";
import { atrSeries, lastOf, emaSeries, rsiSeries, vwapSeries } from "./indicators";
import { computeProfile } from "./volumeProfile";
import { buildZones, zoneMap } from "./srEngine";
import { FlowTracker, flowContext, detectCvdDivergence, footprintRows, flowConfirmation, cvdMomentum, CvdMomentum } from "./orderflow";
import { analyzeChain, futuresInterpretation, ChainAnalytics } from "./options";
import { buildScanner, ScannerOutput, Baseline, FlowConfirmView } from "./scanner";
import { buildDominance, DominanceOutput, DominanceStructure } from "./dominance";
import { buildUnifiedSR, UnifiedSR } from "./unifiedSR";
import type { OiTradeContext } from "./signals";
import {
  OiHistory, OiObservation, StrikeObservation, OiIntelligence,
  buildWindow, buildOiZones, classifyOiMomentum, classifyPosture,
  inferStrikeInterval, resolveAtm, focusBand, StrikePosture,
} from "./oiIntelligence";
import { deriveSignals } from "./signals";
import { encryptSecret, decryptSecret, secretKeySource } from "./secure";
import {
  loadPollConfig, RateLimiter, RotationCursor, PollConfig,
  buildCoverage, effectiveQuoteMs, CoverageReport,
} from "./restScheduler";

const CHAIN_MS_FALLBACK = 20_000;
const ANALYSIS_MS_FALLBACK = 12_000;
/** F&O stocks analysed per Trade Finder cycle (bounded compute budget). */
const ANALYSIS_STOCKS_PER_CYCLE = 6;
/** Stock option chains refreshed per chain cycle (bounded request budget). */
const CHAINS_PER_CYCLE = 2;
const QUOTE_STALE_MS = 25_000;

interface CandleCacheEntry { at: number; candles: Candle[] }
interface ChainMeta { expiry: string | null; fetchedAt: number }

class Engine {
  booted = false;
  startedAt = Date.now();
  token: string | null = null;
  profile: UpstoxProfile | null = null;
  tokenStatus: "NONE" | "VALID" | "EXPIRED" | "INVALID" = "NONE";
  universe: Universe | null = null;
  universeError: string | null = null;
  counters = { quotesReceived: 0, quotesProcessed: 0, quotesDropped: 0, chainFetches: 0, candleFetches: 0, errors: 0, lastError: null as string | null, lastErrorAt: 0 };
  quotes = new Map<string, Quote>();
  baselines = new Map<string, Baseline>();
  baselinePending = new Set<string>();
  /** Prior-session EOD snapshots from provider daily candles (public endpoint) — used ONLY in degraded/no-token mode, labelled EOD. */
  eodEq = new Map<string, { symbol: string; close: number; prevClose: number; changePct: number; volume: number; date: string }>();
  eodIdx = new Map<string, { close: number; prevClose: number; changePct: number; date: string }>();
  private eodIdxAt = 0;
  trackers = new Map<string, FlowTracker>();
  chainViews = new Map<string, ChainAnalytics>();
  chainMeta = new Map<string, ChainMeta>();
  refSnapshots = new Map<string, { at: number; oi: Map<string, number> }>();
  futInterpByEquity = new Map<string, string>();
  scanner: ScannerOutput | null = null;
  scanAt = 0;
  signalsBoard: Signal[] = [];
  /** user-selected focused instrument (drives stock chains + tracking) */
  focusKey: string | null = null;
  /** REST-only market data — no WebSocket is opened anywhere in this app. */
  pollConfig: PollConfig = loadPollConfig();
  limiter: RateLimiter = new RateLimiter(this.pollConfig.rateRps, this.pollConfig.rateBurst);
  rotation = new RotationCursor(this.pollConfig.maxKeysPerCycle);
  /** Latest honest coverage report for the F&O equity universe. */
  coverage: CoverageReport | null = null;
  /** Provider diagnostics — sanitized; pair (endpoint latency, errors) NEVER include credentials */
  private diags: { t: number; endpoint: string; http: number | null; ms: number; requested: number; returned: number; validLtp: number; missing: number; note: string }[] = [];
  private static readonly MAX_DIAGS = 14;
  private prevChainOi = new Map<string, Map<string, { ce: number; pe: number }>>();
  candleCache = new Map<string, CandleCacheEntry>();
  analysisCache = new Map<string, { at: number; payload: ChartAnalysis }>();
  lastPollAt: number | null = null;
  lastChainAt: number | null = null;
  consecutivePollFailures = 0;
  pollCycles = 0;
  pollCyclesFailed = 0;
  /** Trade Finder per-instrument analysis timestamps + skip reasons. */
  analysisAt = new Map<string, number>();
  analysisSkipped = new Map<string, string>();
  private stockQueueCursor = 0;
  /** Per-underlying option-chain status (loaded / pending / unsupported / failed). */
  chainStatus = new Map<string, { state: "LOADED" | "PENDING" | "UNSUPPORTED" | "FAILED"; expiry: string | null; at: number; note: string }>();
  private chainQueueCursor = 0;
  /** Guards against duplicate concurrent chain requests for one underlying. */
  private chainInFlight = new Set<string>();
  /** Last expiry used per underlying — detects expiry rollover for OI baselines. */
  private chainExpiryByKey = new Map<string, string>();
  /** Timestamped per-contract OI observations powering 5m/15m/session windows. */
  oiHistory = new OiHistory();
  /** Previous unified S/R per instrument — enables hysteresis (anti-flicker). */
  private unifiedSrCache = new Map<string, UnifiedSR>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private pollBusy = false;
  private chainBusy = false;
  private analysisBusy = false;

  // ------------------------------------------------------------------ boot

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    await this.ensureSchema();
    try {
      const rows = await this.withTimeout(
        db.select().from(settingsTable).where(eq(settingsTable.key, "upstox_token")),
        8000,
        [] as { value: string }[]
      );
      // tokens stored AES-256-GCM encrypted; legacy plaintext rows are read
      // for migration and re-encrypted immediately on successful validation
      const savedEnc = rows[0]?.value ?? null;
      const saved = savedEnc ? decryptSecret(savedEnc) : null;
      if (savedEnc && saved) {
        // legacy plaintext migration: re-encrypt immediately
        db.update(settingsTable)
          .set({ value: encryptSecret(saved), updatedAt: new Date() })
          .where(eq(settingsTable.key, "upstox_token"))
          .catch(() => undefined);
      } else if (savedEnc && !saved) {
        // undecryptable row (key changed/rotated): expire it honestly
        await this.alert("WARN", "Stored Upstox token could not be decrypted (encryption key changed) — cleared; please re-login.");
        await db.delete(settingsTable).where(eq(settingsTable.key, "upstox_token")).catch(() => undefined);
      }
      if (saved) {
        try {
          this.profile = await validateToken(saved);
          this.token = saved;
          this.tokenStatus = "VALID";
        } catch {
          this.token = null;
          this.tokenStatus = "EXPIRED";
        }
      }
    } catch (e) {
      this.noteError("settings read failed", e);
    }
    void this.refreshUniverse();
    /**
     * ONE coordinated scan timer (default 30s) instead of three competing
     * loops. Quotes, chains, scanner, dominance, S/R and Trade Finder all
     * refresh from the same cycle, so the UI never shows mixed timestamps.
     * Market-hours aware: outside the session the cadence slows automatically.
     */
    this.timers.push(
      setInterval(() => void this.runScanCycle("AUTO"), effectiveQuoteMs(this.pollConfig))
    );
    this.timers.push(setInterval(() => void this.baselineLoop(), 120));
    void this.runScanCycle("AUTO");
  }

  /**
   * ------------------------------------------------------------------
   * COORDINATED SCAN CYCLE
   *
   * One shared pipeline used by BOTH the 30-second automatic schedule and the
   * manual "Scan Now" button, so a manual scan can never diverge from an
   * automatic one. Overlapping scans are rejected (not queued) and manual
   * scans go through the same rate limiter — they cannot bypass it.
   * ------------------------------------------------------------------
   */
  scanState: {
    status: "IDLE" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED" | "RATE_LIMITED";
    startedAt: number | null;
    finishedAt: number | null;
    lastSuccessAt: number | null;
    durationMs: number | null;
    trigger: "AUTO" | "MANUAL" | null;
    evaluated: number;
    failed: number;
    error: string | null;
    cycles: number;
  } = {
    status: "IDLE", startedAt: null, finishedAt: null, lastSuccessAt: null,
    durationMs: null, trigger: null, evaluated: 0, failed: 0, error: null, cycles: 0,
  };
  private scanInFlight = false;

  /**
   * Run one complete scan: quotes → scanner/dominance → option chains →
   * structure/Trade Finder. Returns the resulting status.
   *
   * A 30s cycle refreshes CURRENT data only; 5m/15m OI windows continue to be
   * derived from timestamped history, never from the polling cadence.
   */
  async runScanCycle(trigger: "AUTO" | "MANUAL"): Promise<typeof this.scanState> {
    if (this.scanInFlight) {
      // duplicate manual click or an overlapping tick — never run twice
      return this.scanState;
    }
    this.scanInFlight = true;
    const started = Date.now();
    this.scanState = {
      ...this.scanState,
      status: "RUNNING", startedAt: started, finishedAt: null,
      trigger, error: null,
    };
    let failed = 0;
    try {
      await this.pollLoop().catch((e) => { failed++; this.noteError("scan: quotes", e); });
      await this.chainLoop().catch((e) => { failed++; this.noteError("scan: chains", e); });
      await this.analysisLoop().catch((e) => { failed++; this.noteError("scan: analysis", e); });

      const coverage = this.coverage;
      const evaluated = this.scanner?.coverage.evaluated ?? this.getEodScanner()?.coverage.evaluated ?? 0;
      const partial = failed > 0 || (coverage ? !coverage.fullCoverage : false);
      const rateLimited = (this.counters.lastError ?? "").includes("429");
      const finished = Date.now();
      this.scanState = {
        status: rateLimited ? "RATE_LIMITED" : failed > 0 && evaluated === 0 ? "FAILED" : partial ? "PARTIAL" : "COMPLETED",
        startedAt: started,
        finishedAt: finished,
        lastSuccessAt: evaluated > 0 ? finished : this.scanState.lastSuccessAt,
        durationMs: finished - started,
        trigger,
        evaluated,
        failed,
        error: failed > 0 ? this.counters.lastError : null,
        cycles: this.scanState.cycles + 1,
      };
    } catch (e) {
      this.noteError("scan cycle", e);
      this.scanState = {
        ...this.scanState,
        status: "FAILED", finishedAt: Date.now(),
        durationMs: Date.now() - started,
        failed: failed + 1,
        error: this.counters.lastError,
        cycles: this.scanState.cycles + 1,
      };
    } finally {
      this.scanInFlight = false;
    }
    return this.scanState;
  }

  /** Re-read env-driven polling configuration (used after settings changes). */
  reloadPollConfig(): void {
    this.pollConfig = loadPollConfig();
    this.limiter = new RateLimiter(this.pollConfig.rateRps, this.pollConfig.rateBurst);
    this.rotation = new RotationCursor(this.pollConfig.maxKeysPerCycle);
  }

  /** Bounded execution so boot/build never stalls on a slow database. */
  private withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
  }

  private async ensureSchema(): Promise<void> {
    const ddl = [
      `create table if not exists settings (key text primary key, value text not null, updated_at timestamptz not null default now())`,
      `create table if not exists oi_snapshots (id serial primary key, instrument_key text not null, kind text not null, underlying_key text, expiry text, strike double precision, option_type text, oi double precision, volume double precision, ltp double precision, tag text not null, session_date text not null, captured_at timestamptz not null default now())`,
      `create table if not exists zones_table (id text primary key, instrument_key text not null, timeframe_min integer not null, side text not null, lower double precision not null, upper double precision not null, mid double precision not null, provenance_group text not null, confirmation_status text not null, state text not null, score double precision not null, breakdown jsonb not null, sources jsonb not null, invalidation double precision, session_date text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`,
      `create table if not exists signals (id text primary key, instrument_key text not null, timeframe_min integer not null, direction text not null, scenario text not null, status text not null, entry double precision, stop double precision, targets jsonb not null, rr double precision, score double precision not null, breakdown jsonb not null, trace jsonb not null, capability_tags jsonb not null, data_quality text not null, session_date text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`,
      `create table if not exists alerts (id serial primary key, level text not null, message text not null, context jsonb, created_at timestamptz not null default now())`,
      `create index if not exists oi_snap_key_idx on oi_snapshots (instrument_key, session_date, tag)`,
      `create index if not exists zones_key_idx on zones_table (instrument_key, session_date)`,
      `create index if not exists signals_session_idx on signals (session_date)`,
    ];
    for (const q of ddl) {
      try {
        await db.execute(sql.raw(q));
      } catch (e) {
        this.noteError("schema ensure failed", e);
      }
    }
  }

  private noteError(context: string, e: unknown) {
    this.counters.errors++;
    const raw = e instanceof Error ? e.message : String(e);
    // Secrets redaction: never include the access token in any logged text.
    const msg = raw.slice(0, 300).replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
    this.counters.lastError = `${context}: ${msg}`;
    this.counters.lastErrorAt = Date.now();
  }

  async alert(level: "INFO" | "WARN" | "ERROR", message: string, context?: unknown) {
    try {
      await db.insert(alertsTable).values({ level, message: message.slice(0, 400), context: context ? JSON.parse(JSON.stringify(context)) : null });
    } catch {
      /* alerting must never crash the engine */
    }
  }

  // ------------------------------------------------------------------ auth

  async login(token: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    const clean = token.trim();
    if (clean.length < 20 || /[^A-Za-z0-9._~+/=-]/.test(clean)) {
      return { ok: false, error: "That does not look like a valid Upstox access token." };
    }
    try {
      const profile = await validateToken(clean);
      this.token = clean;
      this.profile = profile;
      this.tokenStatus = "VALID";
      this.pollBusy = false; // release any halt from a previous logout/invalidation
      this.rotation.reset();
      await db.insert(settingsTable).values({ key: "upstox_token", value: encryptSecret(clean) })
        .onConflictDoUpdate({ target: settingsTable.key, set: { value: encryptSecret(clean), updatedAt: new Date() } });
      await this.alert("INFO", "Upstox token validated", { user: profile.userName });
      // End-to-end probe: a token is not "connected" until live quotes answer.
      try {
        const probeKey = this.universe?.indices.NIFTY?.instrumentKey ?? "NSE_INDEX|Nifty 50";
        const probe = await fetchQuotes([probeKey], clean);
        const ltp = probe[0]?.ltp;
        if (ltp === null || ltp === undefined) {
          await this.alert("WARN", "Token valid but live quote probe returned no LTP — check API entitlements/plan");
        } else {
          await this.alert("INFO", `Live data verified: NIFTY 50 LTP ${ltp}`);
        }
      } catch (probeErr) {
        this.noteError("login quote probe", probeErr);
        await this.alert("WARN", "Token validated but the live quote probe failed — see System tab for the engine error");
      }
      void this.pollLoop();
      void this.chainLoop();
      return { ok: true, name: profile.userName };
    } catch (e) {
      // A failed token attempt must NOT clobber an already-running valid
      // session, nor leak a stale profile name for an invalid token.
      if (!(this.token && this.tokenStatus === "VALID")) {
        this.tokenStatus = "INVALID";
        this.profile = null;
      }
      const status = e instanceof UpstoxError ? e.status : 0;
      return { ok: false, error: status === 401 ? "Upstox rejected this token (expired or invalid). Tokens typically expire at 03:30 IST following generation." : "Could not reach Upstox to validate the token. Check connectivity and retry." };
    }
  }

  async logout(): Promise<void> {
    this.token = null;
    this.profile = null;
    this.tokenStatus = "NONE";
    // Halt REST polling and drop cached market data so nothing stale survives
    // a logout. No socket to close — REST polling is timer driven.
    this.pollBusy = true;
    this.quotes.clear();
    this.coverage = null;
    this.rotation.reset();
    try {
      await db.delete(settingsTable).where(eq(settingsTable.key, "upstox_token"));
      await this.alert("INFO", "Token removed — REST polling halted");
    } catch (e) {
      this.noteError("logout", e);
    }
  }

  /** Re-validate a degraded but present token (e.g. transient 401/network). */
  private lastRevalidateAt = 0;
  private async maybeRevalidate(): Promise<void> {
    if (!this.token || this.tokenStatus === "VALID") return;
    if (Date.now() - this.lastRevalidateAt < 60_000) return;
    this.lastRevalidateAt = Date.now();
    try {
      this.profile = await validateToken(this.token);
      this.tokenStatus = "VALID";
      await this.alert("INFO", "Upstox token re-validated and live data restored");
    } catch {
      /* stays INVALID/EXPIRED until the user re-logs in */
    }
  }

  // --------------------------------------------------------------- universe

  async refreshUniverse(attempt = 0): Promise<void> {
    try {
      this.universe = await loadUniverse();
      this.universeError = null;
      await this.alert("INFO", "Instrument master refreshed", {
        raw: this.universe.countRaw,
        foEquities: this.universe.foEquities.length,
        indices: Object.entries(this.universe.indices).map(([k, v]) => `${k}:${v ? "ok" : "missing"}`),
      });
      // queue baselines for all F&O equities (staggered by baselineLoop)
      for (const eq of this.universe.foEquities) this.baselinePending.add(eq.instrumentKey);
    } catch (e) {
      this.noteError("instrument master refresh", e);
      this.universeError = this.counters.lastError;
      const delay = Math.min(300_000, 10_000 * 2 ** Math.min(attempt, 5)) + Math.random() * 3000;
      this.timers.push(setTimeout(() => void this.refreshUniverse(attempt + 1), delay));
    }
  }

  // ------------------------------------------------------------- baselines

  private async baselineLoop(): Promise<void> {
    if (this.baselinePending.size === 0) return;
    const key = this.baselinePending.values().next().value as string;
    this.baselinePending.delete(key);
    if (this.baselines.has(key)) return;
    try {
      const to = istDateKey(Date.now());
      const from = istDateKey(Date.now() - 90 * 86_400_000);
      const days = await fetchHistoricalCandles(key, "day", to, from, this.token);
      this.counters.candleFetches++;
      const completed = days.filter((d) => d.t < Date.now() - 86_400_000);
      const vols = completed.slice(-20).map((d) => d.v).filter((v) => v > 0);
      const avgVol20 = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
      const atr14 = lastOf(atrSeries(completed.map((d) => ({ ...d, closed: true })), 14));
      // EOD snapshot for degraded (no-token) browsing — real provider daily data
      const eqMeta = this.universe?.foEquities.find((e) => e.instrumentKey === key);
      const last = completed[completed.length - 1];
      const prev = completed[completed.length - 2];
      // Independent previous close: the last COMPLETED daily candle before today
      this.baselines.set(key, { avgVol20, atr14, prevClose: prev?.c ?? null });
      if (last && prev && prev.c > 0) {
        this.eodEq.set(key, {
          symbol: eqMeta?.tradingSymbol ?? key,
          close: last.c,
          prevClose: prev.c,
          changePct: round4(((last.c - prev.c) / prev.c) * 100),
          volume: last.v,
          date: istDateKey(last.t),
        });
      }
    } catch (e) {
      this.noteError(`baseline ${key}`, e);
      this.baselines.set(key, { avgVol20: null, atr14: null });
    }
  }

  // ------------------------------------------------------------- poll loop

  /**
   * REST polling key selection (replaces the former WebSocket subscription
   * list). Priority instruments are polled every cycle; the equity universe
   * and stock-futures follow via the rotation cursor when the per-cycle
   * request budget cannot hold everything.
   *
   * Selection is driven by the INSTRUMENT MASTER + EOD turnover — never by
   * scanner output, so there is no circular coverage dependency: a stock does
   * not need to rank before it receives quotes.
   */
  private restPollSelection(): { keys: string[]; deferred: number; fullCoverage: boolean } {
    const u = this.universe;
    if (!u) return { keys: [], deferred: 0, fullCoverage: true };

    // Always polled: spot indices, index futures, and the focused instrument.
    const priority: string[] = [];
    for (const idx of Object.values(u.indices)) if (idx) priority.push(idx.instrumentKey);
    for (const name of ["NIFTY", "BANKNIFTY", "SENSEX"]) {
      const f = u.futures.get(name)?.[0];
      if (f) priority.push(f.instrumentKey);
    }
    if (this.focusKey) priority.push(this.focusKey);
    // CRITICAL: also poll the RESOLVED flow source. Without this, a spot index
    // (no volume) would have no volume-bearing series to read flow from.
    for (const idx of Object.values(u.indices)) {
      if (!idx) continue;
      const src = this.resolveFlowSource(idx.instrumentKey);
      if (src.isProxy) priority.push(src.sourceKey);
    }

    // Rotated: EOD-turnover leaders first, then the remaining equities, then
    // current-month stock futures (needed for futures/OI positioning context).
    const tierA = this.scannerTierA();
    const tierASet = new Set(tierA);
    const rest: string[] = [
      ...tierA,
      ...u.foEquities.map((e) => e.instrumentKey).filter((k) => !tierASet.has(k)),
    ];
    for (const [name, futs] of u.futures) {
      if (["NIFTY", "BANKNIFTY", "SENSEX"].includes(name)) continue;
      if (futs[0]) rest.push(futs[0].instrumentKey);
    }

    const sel = this.rotation.select([...new Set(priority)], [...new Set(rest)]);
    return { keys: sel.keys, deferred: sel.deferred, fullCoverage: sel.fullCoverage };
  }

  /** Log a sanitized provider diagnostic (no secrets, no headers). */
  private diag(endpoint: string, http: number | null, ms: number, requested: number, returned: number, validLtp: number, missing: number, note: string) {
    this.diags.push({ t: Date.now(), endpoint, http, ms, requested, returned, validLtp, missing, note: note.slice(0, 160) });
    if (this.diags.length > Engine.MAX_DIAGS) this.diags.splice(0, this.diags.length - Engine.MAX_DIAGS);
  }

  /**
   * Scanner-tier universe: the complete F&O equity universe, split into
   * deterministic priority bands so coverage is transparent (not circular).
   * Tier A: top tier by EOD turnover once baselines exist, else alphabetical head.
   * Tier B: the remainder — covered by REST polling in chunks.
   */
  private scannerTierA(): string[] {
    const u = this.universe;
    if (!u) return [];
    const scored = u.foEquities.map((e) => {
      const eod = this.eodEq.get(e.instrumentKey);
      const tcr = eod ? (eod.close * eod.volume) / 1e7 : 0;
      return { key: e.instrumentKey, tcr };
    });
    scored.sort((a, b) => b.tcr - a.tcr || a.key.localeCompare(b.key));
    return scored.slice(0, 110).map((s) => s.key);
  }

  // (see restPollSelection below — it replaces the former WebSocket
  //  subscription list with an honest, rotation-based REST key selection)
  // (stock futures are appended to the rotated set inside restPollSelection)

  /**
   * Merge a REST quote into the cache WITHOUT destroying previously valid
   * fields: REST quote responses can omit depth/OI for some instruments, so a
   * null in the new payload must not blank a value we already hold. Only
   * fields present in the current response overwrite the cache.
   */
  private mergeRestQuote(q: Quote): void {
    const prev = this.quotes.get(q.instrumentKey);
    const next: Quote = {
      instrumentKey: q.instrumentKey,
      source: "UPSTOX_REST_POLL",
      exchangeTs: q.exchangeTs ?? prev?.exchangeTs ?? null,
      lastTradeTs: q.lastTradeTs ?? prev?.lastTradeTs ?? null,
      localTs: q.localTs,
      ltp: q.ltp ?? prev?.ltp ?? null,
      ltq: q.ltq ?? prev?.ltq ?? null,
      volumeCum: q.volumeCum ?? prev?.volumeCum ?? null,
      oi: q.oi ?? prev?.oi ?? null,
      open: q.open ?? prev?.open ?? null,
      high: q.high ?? prev?.high ?? null,
      low: q.low ?? prev?.low ?? null,
      close: q.close ?? prev?.close ?? null,
      netChange: q.netChange ?? prev?.netChange ?? null,
      atp: q.atp ?? prev?.atp ?? null,
      bid: q.bid ?? prev?.bid ?? null,
      ask: q.ask ?? prev?.ask ?? null,
      bids: q.bids?.length ? q.bids : prev?.bids,
      asks: q.asks?.length ? q.asks : prev?.asks,
      depthLevels: q.depthLevels || prev?.depthLevels || 0,
      quality: q.quality,
    };
    this.quotes.set(q.instrumentKey, next);
  }

  setFocus(key: string | null) {
    this.focusKey = key;
    if (key) void this.trackerFor(key);
  }

  /** Underlying key whose option chain applies to a given instrument. */
  resolveChainKey(instrumentKey: string): string | null {
    const u = this.universe;
    if (!u) return null;
    for (const idx of Object.values(u.indices)) if (idx?.instrumentKey === instrumentKey) return instrumentKey;
    for (const eq of u.foEquities) if (eq.instrumentKey === instrumentKey) return instrumentKey;
    const eqKey = u.futToEq.get(instrumentKey);
    if (eqKey) return eqKey;
    return null;
  }

  private async pollLoop(): Promise<void> {
    if (this.pollBusy) return;
    this.pollBusy = true;
    try {
      if (this.tokenStatus !== "VALID") {
        await this.maybeRevalidate(); // transient 401/network — one attempt/min
      }
      if (this.tokenStatus !== "VALID" || !this.token || !this.universe) return;

      // Market closed: keep polling slowly so EOD panels stay truthful, but do
      // not burn the request budget on an unchanged book.
      const phase = marketPhase();
      if (phase !== "OPEN") {
        if (this.lastPollAt && Date.now() - this.lastPollAt < this.pollConfig.closedQuoteMs) return;
      }

      // REST-only selection: priority instruments + rotating equity universe
      const sel = this.restPollSelection();
      if (sel.keys.length === 0) {
        this.lastPollAt = Date.now();
        this.buildScannerNow();
        return;
      }

      const t0 = Date.now();
      const token = this.token;
      const quotes: Quote[] = [];
      const batch = this.pollConfig.quoteBatch;
      for (let i = 0; i < sel.keys.length; i += batch) {
        const chunk = sel.keys.slice(i, i + batch);
        await this.limiter.acquire(); // one request per provider-supported batch
        const part = await fetchQuotes(chunk, token);
        quotes.push(...part);
      }
      const validLtp = quotes.filter((q) => q.ltp !== null && Number.isFinite(q.ltp) && q.ltp > 0).length;
      const eligible = this.universe.foEquities.length;
      this.coverage = buildCoverage(eligible, sel.keys.length, quotes.length, validLtp, sel.deferred);
      this.diag(
        "market-quote/quotes",
        200,
        Date.now() - t0,
        sel.keys.length,
        quotes.length,
        validLtp,
        Math.max(0, sel.keys.length - quotes.length),
        sel.fullCoverage ? "full universe" : `partial cycle: ${sel.deferred} deferred to next rotation`
      );
      this.counters.quotesReceived += quotes.length;
      const now = Date.now();
      for (const q of quotes) {
        if (q.ltp === null || !Number.isFinite(q.ltp) || q.ltp <= 0) {
          this.counters.quotesDropped++;
        } else {
          this.counters.quotesProcessed++;
        }
        q.quality = this.freshness(q.localTs, now);
        this.mergeRestQuote(q);
        // estimated order flow from poll-level volume/price increments
        // bid/ask PRICES enable quote-rule classification (preferred over the
        // tick rule). Depth quantities are never used to derive volume.
        this.trackerFor(q.instrumentKey).onQuote(q.ltp, q.volumeCum, q.localTs, {
          bid: q.bid?.p ?? null,
          ask: q.ask?.p ?? null,
        });
      }
      this.lastPollAt = now;
      this.consecutivePollFailures = 0;
      this.buildFuturesInterpretations();
      this.buildScannerNow();
    } catch (e) {
      this.noteError("poll", e);
      this.consecutivePollFailures++;
      this.pollCyclesFailed++;
      const up = e instanceof UpstoxError ? e : null;
      this.diag("market-quote/quotes", up ? up.status : null, 0, 0, 0, 0, 0, up ? `http ${up.status}` : "network");
      if (e instanceof UpstoxError && e.status === 401) {
        this.tokenStatus = "EXPIRED";
        this.token = null;
        await this.alert("WARN", "Upstox token expired during polling (401). Please re-login.");
      } else {
        // bounded exponential backoff with jitter (rule: reconnection policy)
        const backoff = Math.min(64_000, this.pollConfig.quoteMs * 2 ** Math.min(this.consecutivePollFailures, 3));
        await new Promise((r) => setTimeout(r, backoff + Math.random() * 0.3 * backoff));
      }
    } finally {
      this.pollBusy = false;
    }
  }

  private freshness(localTs: number, now: number): DataQuality {
    const age = now - localTs;
    if (age <= QUOTE_STALE_MS) return "LIVE";
    if (age <= 120_000) return "STALE";
    return "UNAVAILABLE";
  }

  /**
   * Instruments whose flow must NEVER be evicted: spot indices and their
   * futures proxies. The previous eviction deleted the FIRST-inserted key and
   * only one per call, so once the polled universe exceeded the cap it
   * silently destroyed the index/index-futures trackers — precisely the series
   * used for NIFTY/SENSEX/BANKNIFTY flow.
   */
  private flowProtectedKeys(): Set<string> {
    const u = this.universe;
    const out = new Set<string>();
    if (!u) return out;
    for (const idx of Object.values(u.indices)) if (idx) out.add(idx.instrumentKey);
    for (const name of ["NIFTY", "BANKNIFTY", "SENSEX"]) {
      const f = u.futures.get(name)?.[0];
      if (f) out.add(f.instrumentKey);
    }
    if (this.focusKey) out.add(this.focusKey);
    return out;
  }

  private trackerFor(key: string): FlowTracker {
    let t = this.trackers.get(key);
    if (!t) {
      t = new FlowTracker();
      this.trackers.set(key, t);
      this.trimTrackers();
    }
    return t;
  }

  /** Evict only non-priority trackers, and loop until actually under the cap. */
  private trimTrackers(): void {
    const MAX = 260;
    if (this.trackers.size <= MAX) return;
    const protectedKeys = this.flowProtectedKeys();
    for (const k of this.trackers.keys()) {
      if (this.trackers.size <= MAX) break;
      if (protectedKeys.has(k)) continue; // never drop index/futures flow
      if (k === this.focusKey) continue;
      this.trackers.delete(k);
    }
  }

  private buildFuturesInterpretations(): void {
    const u = this.universe;
    if (!u) return;
    for (const [, futs] of u.futures) {
      const f = futs[0];
      if (!f) continue;
      const q = this.quotes.get(f.instrumentKey);
      if (!q || q.ltp === null || q.close === null || q.oi === null) continue;
      const priceChg = ((q.ltp - q.close) / q.close) * 100;
      const ref = this.refSnapshots.get(f.instrumentKey);
      if (!ref) {
        // capture session reference for futures OI
        const oiMap = new Map<string, number>([[f.instrumentKey, q.oi]]);
        this.refSnapshots.set(f.instrumentKey, { at: Date.now(), oi: oiMap });
        this.persistOiSnapshot(f, q, "SESSION_REF");
        continue;
      }
      const refOi = ref.oi.get(f.instrumentKey) ?? q.oi;
      const oiChg = refOi > 0 ? ((q.oi - refOi) / refOi) * 100 : null;
      const interp = futuresInterpretation(priceChg, oiChg);
      const eqKey = u.futToEq.get(f.instrumentKey);
      if (interp && eqKey) this.futInterpByEquity.set(eqKey, interp.label);
    }
  }

  /**
   * Build ESTIMATED flow confirmation per instrument from the REST-fed
   * trackers. Instruments without a tracker simply have no entry — the
   * scanner treats that as "unavailable", never as bearish evidence.
   */
  /**
   * Build ESTIMATED flow confirmation per instrument.
   *
   * Keys are the INSTRUMENT keys the scanner and Trade Finder look up by
   * (spot-index keys included), and each value is computed from that
   * instrument's RESOLVED flow source — so NIFTY/SENSEX/BANKNIFTY flow comes
   * from their nearest non-expired index-futures contract rather than being
   * permanently unavailable. Values are identical to cvdMomentumFor() because
   * both now derive from the single CVD momentum engine.
   */
  private buildFlowConfirmations(): Map<string, FlowConfirmView> {
    const out = new Map<string, FlowConfirmView>();
    const now = Date.now();
    const u = this.universe;
    if (!u) return out;

    // Candidate consumers: every eligible equity plus the spot indices.
    const wanted = new Set<string>(u.foEquities.map((e) => e.instrumentKey));
    for (const idx of Object.values(u.indices)) if (idx) wanted.add(idx.instrumentKey);
    if (this.focusKey) wanted.add(this.resolveFlowSource(this.focusKey).sourceKey);

    for (const key of wanted) {
      const src = this.resolveFlowSource(key);
      const tracker = this.trackers.get(src.sourceKey);
      if (!tracker || tracker.tickCount === 0) continue;
      const bars = tracker.bars(5);
      if (bars.length === 0) continue;
      const closes = bars
        .map((b) => {
          const ps = Object.keys(b.perPrice).map(Number).filter((p) => Number.isFinite(p));
          return ps.length ? ps[ps.length - 1] : 0;
        })
        .filter((p) => p > 0);
      const fc = flowConfirmation(bars, tracker.attribution(), closes, now, 6);
      const proxyNote = src.isProxy ? ` · via ${src.sourceLabel ?? src.sourceKey}` : "";
      out.set(key, {
        status: fc.status,
        available: fc.available,
        reason: `${fc.reason}${proxyNote}`,
        deltaRatio: fc.deltaRatio,
        cvdSlope: fc.cvdSlope,
        attributionPct: fc.attributionPct,
        score: fc.score,
        label: `${fc.label}${proxyNote}`,
      });
    }
    return out;
  }

  private buildScannerNow(): void {
    const u = this.universe;
    if (!u) return;
    const nifty = u.indices.NIFTY ? this.quotes.get(u.indices.NIFTY.instrumentKey) : undefined;
    const niftyChange = nifty && nifty.ltp !== null && nifty.close ? ((nifty.ltp - nifty.close) / nifty.close) * 100 : null;
    const now = Date.now();
    this.scanner = buildScanner({
      universe: u.foEquities,
      quotes: this.quotes,
      baselines: this.baselines,
      futInterpByEquity: this.futInterpByEquity,
      proximityByEquity: new Map(),
      niftyChangePct: niftyChange,
      elapsedFraction: sessionElapsedFraction(now),
      now,
      minTurnoverCr: 25,
      flowByKey: this.buildFlowConfirmations(),
      staleMs: 60_000,
    });
    this.scanAt = now;
  }

  // ------------------------------------------------------------ chain loop

  private async chainLoop(): Promise<void> {
    if (this.chainBusy) return;
    this.chainBusy = true;
    try {
      const token = this.token;
      if (this.tokenStatus !== "VALID" || !token || !this.universe) return;
      /**
       * Chain scheduler: indices every cycle, then the focused stock, then a
       * bounded rotation through F&O stocks that ACTUALLY have listed options
       * (capability resolved from the instrument master, so no API calls are
       * wasted on unsupported underlyings).
       */
      const uni = this.universe;
      const targets: { key: string; symbol: string }[] = [];
      const seen = new Set<string>();
      const push = (key: string | null | undefined, symbol: string) => {
        if (!key || seen.has(key)) return;
        if (!uni.optionUnderlyings.has(key)) {
          // provably unsupported from the master — record, never request
          if (!this.chainStatus.has(key)) {
            this.chainStatus.set(key, { state: "UNSUPPORTED", expiry: null, at: Date.now(), note: "no listed option contracts in the instrument master" });
          }
          return;
        }
        seen.add(key);
        targets.push({ key, symbol });
      };

      for (const idx of [uni.indices.NIFTY, uni.indices.SENSEX, uni.indices.BANKNIFTY]) {
        if (idx) push(idx.instrumentKey, idx.tradingSymbol);
      }
      const focused = this.focusKey ? this.resolveChainKey(this.focusKey) : null;
      if (focused) push(focused, this.metaOf(focused)?.tradingSymbol ?? focused);
      // rotation over option-enabled equities
      const optEquities = uni.foEquities.filter((e) => uni.optionUnderlyings.has(e.instrumentKey));
      for (let i = 0; i < optEquities.length && targets.length < 3 + 1 + CHAINS_PER_CYCLE; i++) {
        const e = optEquities[(this.chainQueueCursor + i) % optEquities.length];
        push(e.instrumentKey, e.tradingSymbol);
      }
      this.chainQueueCursor = (this.chainQueueCursor + CHAINS_PER_CYCLE) % Math.max(optEquities.length, 1);

      for (const und of targets) {
        if (this.chainInFlight.has(und.key)) continue; // no duplicate concurrent requests
        this.chainInFlight.add(und.key);
        try {
          this.chainStatus.set(und.key, { state: "PENDING", expiry: null, at: Date.now(), note: "fetching" });
          await this.updateChain(und.key, und.symbol, token);
        } catch (e) {
          const msg = e instanceof UpstoxError ? `HTTP ${e.status}` : "network error";
          this.chainStatus.set(und.key, { state: "FAILED", expiry: null, at: Date.now(), note: msg });
          this.noteError(`chain ${und.symbol}`, e);
          if (e instanceof UpstoxError && e.status === 401) {
            this.tokenStatus = "EXPIRED";
            this.token = null;
          }
        } finally {
          this.chainInFlight.delete(und.key);
        }
      }
    } finally {
      this.chainBusy = false;
    }
  }

  /**
   * Fetch + analyse one underlying's option chain, persist reference/live
   * snapshots, and track both change semantics:
   *   ΔOI_session    = current OI − SESSION_REF (first snapshot of the day)
   *   ΔOI_lastSnap   = current OI − previous POLL (~60 s ago)
   */
  private async updateChain(underlyingKey: string, tradingSymbol: string, token: string): Promise<void> {
    let meta = this.chainMeta.get(underlyingKey);
    if (!meta || Date.now() - meta.fetchedAt > 30 * 60_000) {
      // Prefer expiries already resolved from the instrument master (zero API
      // cost, always current). Fall back to the documented contract endpoint.
      const fromMaster = this.universe?.optionUnderlyings.get(underlyingKey)?.expiries ?? [];
      const expiries = fromMaster.length
        ? fromMaster
        : (await fetchOptionContracts(underlyingKey, token)).expiries;
      meta = { expiry: pickNearestExpiry(expiries), fetchedAt: Date.now() };
      this.chainMeta.set(underlyingKey, meta);
    }
    const expiry = meta.expiry;
    if (!expiry) return;
    // Expired contracts defensively skipped: pickNearestExpiry returns the
    // nearest expiry >= today (0DTE included) or null.
    const chain = await fetchOptionChain(underlyingKey, expiry, token);
    this.counters.chainFetches++;
    this.lastChainAt = Date.now();
    const session = istDateKey(Date.now());
    if (!this.refSnapshots.has(`${underlyingKey}|${session}`)) {
      const oi = new Map<string, number>();
      for (const s of chain) {
        if (s.call_options?.instrument_key) oi.set(s.call_options.instrument_key, s.call_options.market_data?.oi ?? 0);
        if (s.put_options?.instrument_key) oi.set(s.put_options.instrument_key, s.put_options.market_data?.oi ?? 0);
      }
      const ref = { at: Date.now(), oi };
      this.refSnapshots.set(`${underlyingKey}|${session}`, ref);
      await this.persistChainRef(chain, underlyingKey, expiry);
    }
    // Expiry rollover: a new expiry must never inherit the prior expiry's
    // OI baseline, so session-reference keys are scoped by expiry.
    const prevExpiry = this.chainExpiryByKey.get(underlyingKey);
    if (prevExpiry && prevExpiry !== expiry) {
      this.refSnapshots.delete(`${underlyingKey}|${session}`);
      this.prevChainOi.delete(underlyingKey);
      // a new contract starts a new observation series — never compare across expiries
      this.oiHistory.clear(underlyingKey, prevExpiry);
    }
    this.chainExpiryByKey.set(underlyingKey, expiry);
    const ref = this.refSnapshots.get(`${underlyingKey}|${session}`) ?? null;
    const spot = this.quotes.get(underlyingKey)?.ltp ?? null;
    const prevSnap = this.prevChainOi.get(underlyingKey) ?? null;
    const analytics = analyzeChain(chain, underlyingKey, expiry, ref?.oi ?? null, ref?.at ?? null, Date.now(), spot, prevSnap);
    this.chainViews.set(underlyingKey, analytics);

    /**
     * Record a TIMESTAMPED observation of the COMPLETE strike ladder (not the
     * ATM±12 UI window) so 5m/15m changes are computed from real history.
     * Premium and volume are captured alongside OI because positioning
     * interpretation needs OI + premium together.
     */
    const strikes = new Map<number, StrikeObservation>();
    for (const s of chain) {
      if (typeof s.strike_price !== "number") continue;
      const cm = s.call_options?.market_data;
      const pm = s.put_options?.market_data;
      strikes.set(s.strike_price, {
        strike: s.strike_price,
        ceOi: typeof cm?.oi === "number" ? cm.oi : null,
        peOi: typeof pm?.oi === "number" ? pm.oi : null,
        ceLtp: typeof cm?.ltp === "number" ? cm.ltp : null,
        peLtp: typeof pm?.ltp === "number" ? pm.ltp : null,
        ceVol: typeof cm?.volume === "number" ? cm.volume : null,
        peVol: typeof pm?.volume === "number" ? pm.volume : null,
      });
    }
    if (strikes.size > 0) {
      const obs: OiObservation = { t: Date.now(), spot: analytics.spot ?? spot, expiry, strikes };
      this.oiHistory.record(underlyingKey, expiry, obs);
    }
    this.chainStatus.set(underlyingKey, {
      state: chain.length > 0 ? "LOADED" : "FAILED",
      expiry,
      at: Date.now(),
      note: chain.length > 0 ? `${chain.length} strikes` : "provider returned an empty chain",
    });
    // store current chain as previous-snapshot baseline for the next cycle
    const nextPrev = new Map<string, { ce: number; pe: number }>();
    for (const r of analytics.oiLevels) nextPrev.set(String(r.strike), { ce: r.ceOi, pe: r.peOi });
    this.prevChainOi.set(underlyingKey, nextPrev);
    // periodic live snapshot for audit history (every ~5 min)
    const lastSnapKey = `live|${underlyingKey}`;
    const lastSnap = this.liveSnapAt.get(lastSnapKey) ?? 0;
    if (Date.now() - lastSnap > 5 * 60_000) {
      this.liveSnapAt.set(lastSnapKey, Date.now());
      await this.persistChainRef(chain, underlyingKey, expiry, "LIVE");
    }
    void tradingSymbol;
  }

  private liveSnapAt = new Map<string, number>();

  private async persistChainRef(chain: Awaited<ReturnType<typeof fetchOptionChain>>, underlyingKey: string, expiry: string, tag: "SESSION_REF" | "LIVE" = "SESSION_REF"): Promise<void> {
    const session = istDateKey(Date.now());
    const rows = chain.flatMap((s) => {
      const base = { kind: "OPT", underlyingKey, expiry, strike: s.strike_price, tag, sessionDate: session };
      const out: (typeof base & { instrumentKey: string; optionType: string; oi: number; volume: number | null; ltp: number | null })[] = [];
      if (s.call_options?.instrument_key) {
        out.push({ ...base, instrumentKey: s.call_options.instrument_key, optionType: "CE", oi: s.call_options.market_data?.oi ?? 0, volume: s.call_options.market_data?.volume ?? null, ltp: s.call_options.market_data?.ltp ?? null });
      }
      if (s.put_options?.instrument_key) {
        out.push({ ...base, instrumentKey: s.put_options.instrument_key, optionType: "PE", oi: s.put_options.market_data?.oi ?? 0, volume: s.put_options.market_data?.volume ?? null, ltp: s.put_options.market_data?.ltp ?? null });
      }
      return out;
    });
    if (rows.length === 0) return;
    try {
      for (let i = 0; i < rows.length; i += 200) {
        await db.insert(oiSnapshots).values(rows.slice(i, i + 200));
      }
    } catch (e) {
      this.noteError("persist chain snapshot", e);
    }
  }

  private persistOiSnapshot(meta: { instrumentKey: string; expiry?: number }, q: Quote, tag: "SESSION_REF" | "LIVE") {
    const session = istDateKey(Date.now());
    void db.insert(oiSnapshots).values({
      instrumentKey: meta.instrumentKey,
      kind: "FUT",
      expiry: meta.expiry ? istDateKey(meta.expiry) : null,
      oi: q.oi,
      volume: q.volumeCum,
      ltp: q.ltp,
      tag,
      sessionDate: session,
    }).catch((e) => this.noteError("persist fut oi", e));
  }

  // -------------------------------------------------------------- analysis

  async getOneMinHistory(instrumentKey: string): Promise<Candle[]> {
    const cacheKey = instrumentKey;
    const cached = this.candleCache.get(cacheKey);
      if (cached && Date.now() - cached.at < 60_000) return cached.candles;
    const now = Date.now();
    const to = istDateKey(now);
    const from = istDateKey(now - 10 * 86_400_000);
    const [hist, today] = await Promise.all([
      fetchHistoricalCandles(instrumentKey, "1minute", to, from, this.token).catch((e) => {
        this.noteError("history", e);
        return [] as Candle[];
      }),
      fetchIntradayCandles(instrumentKey, "1minute", to, this.token).catch(() => [] as Candle[]),
    ]);
    this.counters.candleFetches += 2;
    const merged = inSession(dedupeSort([...hist, ...today]));
    this.candleCache.set(cacheKey, { at: now, candles: merged });
    return merged;
  }

  async getAnalysis(instrumentKey: string, tfMin: number): Promise<ChartAnalysis | null> {
    const cacheKey = `${instrumentKey}|${tfMin}`;
    const cached = this.analysisCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 20_000) return cached.payload;
    const meta = this.metaOf(instrumentKey);
    const tickSize = meta?.tickSize ?? 0.05;

    const oneMin = await this.getOneMinHistory(instrumentKey).catch(() => [] as Candle[]);
    const candles = resample(oneMin, tfMin);
    const closed = candles.filter((c) => c.closed);
    const now = Date.now();
    const quote = this.quotes.get(instrumentKey) ?? null;

    // Quality semantics: LIVE only inside market hours with a fresh quote;
    // a closed but connected market (weekend/holiday/overnight) never masquerades as LIVE.
    const openNow = marketPhase(now) === "OPEN";
    let quality: DataQuality;
    if (closed.length === 0) quality = "UNAVAILABLE";
    else if (openNow && quote && now - quote.localTs <= QUOTE_STALE_MS) quality = "LIVE";
    else if (openNow && closed[closed.length - 1].t >= now - 10 * 60_000) quality = "LIVE";
    else if (!openNow) quality = "HISTORICAL";
    else quality = "STALE";

    const notes: string[] = [];
    if (closed.length < 40) notes.push("limited candle history — analysis confidence reduced");
    const gaps = gapReport(closed, tfMin);
    if (gaps.length > 0) notes.push(`${gaps.length} missing ${tfMin}m interval(s) detected — gaps are NOT filled with fabricated bars`);

    const structure = analyzeStructure(candles);
    const atr = lastOf(atrSeries(closed, 14)) ?? 0;

    // session slices
    const sessions = bySession(candles);
    const sessionDates = [...sessions.keys()].sort();
    const todayKey = sessionDates[sessionDates.length - 1] ?? istDateKey(now);
    const todayCandles = sessions.get(todayKey) ?? [];
    const prevDate = sessionDates[sessionDates.length - 2];
    const prevCandles = prevDate ? sessions.get(prevDate) ?? [] : [];

    // volume profile: today's volume-bearing candles only
    const hasVol = todayCandles.some((c) => c.v > 0);
    const profile = hasVol ? computeProfile(todayCandles, tickSize) : null;
    if (!hasVol) notes.push("instrument carries no bar volume (index) — volume profile UNAVAILABLE here; use futures chart for profile");

    // OI levels from chain view (indices) else null
    const chain = this.chainViews.get(instrumentKey) ?? null;
    const oiLevels = chain?.oiLevels ?? null;

    const zones = buildZones({
      instrumentKey,
      timeframeMin: tfMin,
      candles,
      structure,
      profile,
      oiLevels,
      tickSize,
      atr,
      // session VWAP as a dynamic S/R reference (null for zero-volume indices)
      vwap: hasVol ? lastOf(vwapSeries(closed)) : null,
      prevSessionHigh: prevCandles.length ? Math.max(...prevCandles.map((c) => c.h)) : null,
      prevSessionLow: prevCandles.length ? Math.min(...prevCandles.map((c) => c.l)) : null,
      prevSessionClose: lastClosed(prevCandles)?.c ?? null,
      now,
    });

    // indicators (tail only for payload size)
    const closes = closed.map((c) => c.c);
    const indicators = {
      ema9: emaSeries(closes, 9).slice(-150),
      ema21: emaSeries(closes, 21).slice(-150),
      ema50: emaSeries(closes, 50).slice(-150),
      vwap: vwapSeries(closed).slice(-150),
      rsi14: rsiSeries(closes, 14).slice(-150),
      atr14: atrSeries(closed, 14).slice(-150),
    };

    // estimated order flow
    const tracker = this.trackers.get(instrumentKey) ?? null;
    let flow: ChartAnalysis["flow"] = null;
    if (tracker && tracker.tickCount > 4) {
      const bars = tracker.bars(Math.min(tfMin, 5));
      flow = { mode: "ESTIMATED", reset: tracker.resetLabel(), bars: bars.slice(-96) };
    } else {
      notes.push("order-flow feed has no ticks yet — DELTA/CVD UNAVAILABLE (never fabricated)");
    }

    const payload: ChartAnalysis = {
      instrumentKey,
      timeframeMin: tfMin,
      quality,
      candles: candles.slice(-150),
      indicators,
      structure: structure.events.slice(-40),
      range: structure.range,
      zones,
      profile: profile
        ? { mode: profile.mode, poc: profile.poc, vah: profile.vah, val: profile.val, hvn: profile.hvn, lvn: profile.lvn }
        : null,
      flow,
      notes,
    };
    if (quote && quality === "LIVE") {
      // patch last partial bar with live LTP for display only (never used for signals)
      const display = payload.candles[payload.candles.length - 1];
      if (display && !display.closed && quote.ltp !== null) {
        display.c = quote.ltp;
        display.h = Math.max(display.h, quote.ltp);
        display.l = Math.min(display.l, quote.ltp);
        notes.push("forming bar patched with live LTP for display only — signals use closed bars exclusively");
      }
    }
    this.analysisCache.set(cacheKey, { at: now, payload });
    return payload;
  }

  private metaOf(instrumentKey: string) {
    const u = this.universe;
    if (!u) return null;
    for (const idx of Object.values(u.indices)) if (idx?.instrumentKey === instrumentKey) return idx;
    for (const eq of u.foEquities) if (eq.instrumentKey === instrumentKey) return eq;
    for (const [, futs] of u.futures) for (const f of futs) if (f.instrumentKey === instrumentKey) return f;
    return null;
  }

  displayNameOf(instrumentKey: string): string {
    const u = this.universe;
    const m = this.metaOf(instrumentKey);
    if (!m) return instrumentKey;
    if (m.instrumentType.startsWith("FUT")) {
      const base = (m.underlyingSymbol ?? m.name).toUpperCase();
      const mon = m.expiry ? new Date(m.expiry + 5.5 * 3600_000).toUTCString().slice(8, 11).toUpperCase() : "";
      return `${base} ${mon} FUT`;
    }
    return m.tradingSymbol || m.name;
    void u;
  }

  // ---------------------------------------------------------- signal loop

  /**
   * Degraded mode: with no valid token, still hydrate EOD index levels from
   * the public daily-candle endpoint so panels show REAL prior-session data,
   * explicitly labelled HISTORICAL. Live scan stays off — never fabricated.
   */
  async refreshEodIndices(): Promise<void> {
    const u = this.universe;
    if (!u) return;
    if (Date.now() - this.eodIdxAt < 30 * 60_000) return;
    this.eodIdxAt = Date.now();
    const to = istDateKey(Date.now());
    const from = istDateKey(Date.now() - 14 * 86_400_000);
    for (const idx of Object.values(u.indices)) {
      if (!idx) continue;
      try {
        const days = await fetchHistoricalCandles(idx.instrumentKey, "day", to, from, this.token);
        this.counters.candleFetches++;
        const completed = days.filter((d) => d.t < Date.now() - 86_400_000);
        const last = completed[completed.length - 1];
        const prev = completed[completed.length - 2];
        if (last && prev && prev.c > 0) {
          this.eodIdx.set(idx.instrumentKey, {
            close: last.c,
            prevClose: prev.c,
            changePct: round4(((last.c - prev.c) / prev.c) * 100),
            date: istDateKey(last.t),
          });
        }
      } catch (e) {
        this.noteError(`eod index ${idx.tradingSymbol}`, e);
      }
    }
  }

  /** EOD momentum snapshot from provider daily candles (degraded mode only). */
  getEodScanner(): ScannerOutput | null {
    if (this.tokenStatus === "VALID") return null; // live scanner exists instead
    if (this.eodIdx.size === 0 && this.eodEq.size === 0) return null;
    const rows: ScannerRow[] = [];
    for (const [key, s] of this.eodEq) {
      const turnoverCr = round4((s.close * s.volume) / 1e7);
      const exclusions: string[] = [];
      if (turnoverCr < 200) exclusions.push(`EOD turnover ${turnoverCr.toFixed(0)} Cr below 200 Cr liquidity floor`);
      // Degraded mode still needs a directional classification, otherwise
      // every downstream consumer scores 0 and the leaderboards are empty.
      const dirEod: 1 | -1 | 0 = Math.abs(s.changePct) >= 0.5 ? (s.changePct > 0 ? 1 : -1) : 0;
      const strengthEod = dirEod === 0 ? 0 : Math.min(1, Math.abs(s.changePct) / 3);
      rows.push({
        instrumentKey: key,
        symbol: s.symbol,
        ltp: s.close, // EOD close — labelled
        changePct: s.changePct,
        liquidityTier: turnoverCr >= 200 ? "HIGH" : turnoverCr >= 50 ? "MODERATE" : turnoverCr >= 25 ? "LOW" : "INSUFFICIENT",
        momentum: {
          classification: dirEod === 0 ? "NO_MOMENTUM" : dirEod > 0 ? "BULLISH_CANDIDATE" : "BEARISH_CANDIDATE",
          direction: dirEod,
          strength: strengthEod,
          participation: 0,
          atrMove: null, // intraday ATR is not applicable to an EOD snapshot
          breakdown: [],
        },
        flow: null, // no intraday observations in degraded mode
        volumeCum: s.volume,
        turnoverCr,
        rvol: null,
        rvolMode: "UNAVAILABLE",
        atrPct: null,
        rsVsNifty: null,
        vwapPos: null,
        futInterp: null,
        proximity: null,
        score: round4(s.changePct * 2 + Math.min(turnoverCr / 500, 2)),
        reasons: [`prior-session EOD close (${s.date}) — not intraday momentum`],
        exclusions,
        quality: "HISTORICAL",
      });
    }
    const elig = rows.filter((r) => r.exclusions.length === 0);
    const byScore = (a: ScannerRow, b: ScannerRow) => b.score - a.score || a.symbol.localeCompare(b.symbol);
    return {
      asOf: Date.now(),
      allRows: rows, // full evaluated EOD universe
      bullish: elig.filter((r) => r.changePct > 0).sort(byScore).slice(0, 12),
      bearish: elig.filter((r) => r.changePct < 0).sort((a, b) => a.score - b.score || a.symbol.localeCompare(b.symbol)).slice(0, 12),
      rvolLeaders: [...elig].sort((a, b) => (b.volumeCum ?? 0) - (a.volumeCum ?? 0)).slice(0, 12),
      liquid: [...elig].sort((a, b) => (b.turnoverCr ?? 0) - (a.turnoverCr ?? 0)).slice(0, 12),
      rejected: [],
      universeSize: this.universe?.foEquities.length ?? rows.length,
      coverage: {
        eligible: this.universe?.foEquities.length ?? rows.length,
        refreshed: 0, // EOD snapshot — nothing was refreshed live this cycle
        stale: 0,
        missingData: 0,
        evaluated: rows.length,
        flowConfirmed: 0,
        flowUnavailable: rows.length,
        qualifying: elig.length,
        lastUpdate: Date.now(),
      },
      notes: [
        "DEGRADED MODE: prior trading session's EOD snapshot built from provider daily candles — no live intraday data without a valid Upstox token.",
        "Scores here rank EOD change + turnover only; intraday RVOL/VS-ATP fields are unavailable by definition.",
      ],
    };
  }

  /**
   * Deterministic, bounded stock queue for Trade Finder analysis.
   *
   * Priority order (no duplicates):
   *   1. the user-selected instrument (always analysed first)
   *   2. current momentum candidates from the scanner (genuinely directional)
   *   3. rotation through the remaining eligible F&O equities
   *
   * This is NOT circular: the rotation guarantees every eligible stock is
   * analysed within a bounded number of cycles even if it never ranks.
   */
  private nextStockAnalysisBatch(limit: number): string[] {
    const u = this.universe;
    if (!u) return [];
    const picked: string[] = [];
    const seen = new Set<string>();
    const add = (k: string | null | undefined) => {
      if (!k || seen.has(k) || picked.length >= limit) return;
      if (!u.foEquities.some((e) => e.instrumentKey === k)) return;
      seen.add(k);
      picked.push(k);
    };

    if (this.focusKey) add(this.resolveChainKey(this.focusKey) ?? this.focusKey);
    for (const r of [...(this.scanner?.bullish ?? []), ...(this.scanner?.bearish ?? [])]) add(r.instrumentKey);

    const all = u.foEquities.map((e) => e.instrumentKey);
    for (let i = 0; i < all.length && picked.length < limit; i++) {
      add(all[(this.stockQueueCursor + i) % all.length]);
    }
    this.stockQueueCursor = (this.stockQueueCursor + limit) % Math.max(all.length, 1);
    return picked;
  }

  /**
   * Structural context per instrument for the dominance engine, taken from
   * the SAME cached chart analysis the chart/Trade Finder use — so the tab,
   * the chart and the signal engine can never disagree, and no extra API
   * calls are made.
   */
  private dominanceStructures(): Map<string, DominanceStructure> {
    const out = new Map<string, DominanceStructure>();
    for (const [cacheKey, entry] of this.analysisCache) {
      if (!cacheKey.endsWith("|5")) continue; // 5-minute analysis is canonical
      const key = cacheKey.slice(0, -2);
      const a = entry.payload;
      const closed = a.candles.filter((c) => c.closed);
      if (closed.length === 0) continue;
      const price = closed[closed.length - 1].c;
      const zm = zoneMap(price, a.zones);
      const lastStruct = a.structure[a.structure.length - 1];
      const trend = a.structure.reduce<"UP" | "DOWN" | "NEUTRAL">((acc, e) => {
        if (e.type === "BOS_UP" || e.type === "CHOCH_UP") return "UP";
        if (e.type === "BOS_DOWN" || e.type === "CHOCH_DOWN") return "DOWN";
        return acc;
      }, "NEUTRAL");
      out.set(key, {
        trend,
        lastEvent: lastStruct ? `${lastStruct.type} @ ${lastStruct.level}` : null,
        zones: a.zones,
        primarySupport: zm.nearestSupport,
        primaryResistance: zm.nearestResistance,
        atr: lastOf(atrSeries(closed, 14)),
        analysedAt: entry.at,
      });
    }
    return out;
  }

  /**
   * Resolve which instrument ACTUALLY supplies trade volume for flow analysis.
   *
   * Spot indices (NIFTY / SENSEX / BANKNIFTY) are computed indexes: Upstox
   * reports no traded volume for them, so a flow tracker fed from a spot index
   * accumulates zero volume and Delta/CVD stays permanently INSUFFICIENT_DATA.
   * The nearest NON-EXPIRED index-futures contract is the correct flow proxy —
   * it is the liquid instrument where those index trades actually execute.
   *
   * Equities use their own key; a stock's flow is NEVER substituted with an
   * index or another stock's series.
   */
  resolveFlowSource(instrumentKey: string): {
    sourceKey: string;
    sourceType: "SPOT_INDEX" | "INDEX_FUTURE" | "EQUITY" | "FUTURE";
    sourceLabel: string | null;
    contractExpiry: string | null;
    isProxy: boolean;
    reason: string;
  } {
    const u = this.universe;
    const base = {
      sourceKey: instrumentKey,
      sourceType: "EQUITY" as const,
      sourceLabel: null as string | null,
      contractExpiry: null as string | null,
      isProxy: false,
      reason: "instrument's own market data",
    };
    if (!u) return base;

    // Already an index future?
    for (const [name, futs] of u.futures) {
      if (!["NIFTY", "BANKNIFTY", "SENSEX"].includes(name)) continue;
      const hit = futs.find((f) => f.instrumentKey === instrumentKey);
      if (hit) {
        return {
          sourceKey: hit.instrumentKey,
          sourceType: "INDEX_FUTURE",
          sourceLabel: this.displayNameOf(hit.instrumentKey),
          contractExpiry: hit.expiry ? istDateKey(hit.expiry) : null,
          isProxy: false,
          reason: "index-futures contract supplies its own volume",
        };
      }
    }

    // Spot index → nearest non-expired index future (verified against today).
    const isSpotIndex = Object.values(u.indices).some((i) => i?.instrumentKey === instrumentKey);
    if (isSpotIndex) {
      const idxName = (["NIFTY", "BANKNIFTY", "SENSEX"] as const).find(
        (n) => u.indices[n]?.instrumentKey === instrumentKey
      );
      const today = istDateKey(Date.now());
      const futs = (idxName ? u.futures.get(idxName) : undefined) ?? [];
      const live = futs
        .filter((f) => f.expiry && istDateKey(f.expiry) >= today) // never expired
        .sort((a, b) => (a.expiry ?? 0) - (b.expiry ?? 0));
      const near = live[0];
      if (near) {
        return {
          sourceKey: near.instrumentKey,
          sourceType: "INDEX_FUTURE",
          sourceLabel: this.displayNameOf(near.instrumentKey),
          contractExpiry: near.expiry ? istDateKey(near.expiry) : null,
          isProxy: true,
          reason: `spot index reports no traded volume — flow proxied from ${this.displayNameOf(near.instrumentKey)} (${near.expiry ? istDateKey(near.expiry) : "expiry n/a"})`,
        };
      }
      return { ...base, sourceType: "SPOT_INDEX", reason: "no non-expired index-futures contract available — FLOW UNAVAILABLE" };
    }

    if (u.futToEq.has(instrumentKey)) {
      const eqKey = u.futToEq.get(instrumentKey)!;
      return { ...base, sourceKey: eqKey, sourceType: "EQUITY", reason: "stock future mapped to its underlying equity for flow" };
    }
    return base;
  }

  /**
   * ESTIMATED CVD momentum for one instrument, from the shared tracker.
   * The scanner, dominance tab, detail view, Trade Finder and alerts all read
   * THIS, so every surface shows the same state and timestamps.
   */
  cvdMomentumFor(instrumentKey: string, barMin = 5): CvdMomentum | null {
    const src = this.resolveFlowSource(instrumentKey);
    const t = this.trackers.get(src.sourceKey);
    if (!t) return null;
    const bars = t.bars(barMin);
    if (bars.length === 0) return null;
    const closes = bars
      .map((b) => {
        const ps = Object.keys(b.perPrice).map(Number).filter((p) => Number.isFinite(p));
        return ps.length ? ps[ps.length - 1] : 0;
      })
      .filter((p) => p > 0);
    const m = cvdMomentum(bars, t.attribution(), closes, 8);
    // Record the true source so every consumer can label it honestly.
    return {
      ...m,
      sourceKey: src.sourceKey,
      sourceType: src.sourceType,
      sourceLabel: src.sourceLabel,
      isProxy: src.isProxy,
      proxyReason: src.reason,
    };
  }

  /** CVD momentum for every tracked instrument (one pass, shared by callers). */
  private cvdMomentumMap(): Map<string, CvdMomentum> {
    const out = new Map<string, CvdMomentum>();
    for (const [key] of this.trackers) {
      const m = this.cvdMomentumFor(key);
      if (m && m.mode === "ESTIMATED") out.set(key, m);
    }
    return out;
  }

  /**
   * Dominance / CVD alerts with cooldown + dedupe so the log never floods.
   * Every alert records the triggering evidence and its data-quality label.
   */
  private lastAlertAt = new Map<string, number>();
  private readonly ALERT_COOLDOWN_MS = 10 * 60_000;

  private async emitFlowAlerts(): Promise<void> {
    const dom = this.getDominance(5);
    if (!dom) return;
    const now = Date.now();
    const fire = async (key: string, level: "INFO" | "WARN", msg: string, ctx: Record<string, unknown>) => {
      const last = this.lastAlertAt.get(key) ?? 0;
      if (now - last < this.ALERT_COOLDOWN_MS) return; // cooldown + dedupe
      this.lastAlertAt.set(key, now);
      await this.alert(level, msg, { ...ctx, dataQuality: "ESTIMATED (REST-derived order flow)", at: now });
    };

    for (const c of [...dom.buyers, ...dom.sellers]) {
      const m = this.cvdMomentumFor(c.instrumentKey);
      if (!m || m.mode !== "ESTIMATED") continue;
      const side = c.side === "BUYER" ? "Buyer" : "Seller";

      if (c.action === "ACTIONABLE" && (m.state === "STRONG_BULLISH" || m.state === "STRONG_BEARISH")) {
        await fire(`${c.instrumentKey}|dominance`, "INFO",
          `${side} dominance strengthening: ${c.symbol} (score ${c.score.toFixed(0)}, ${m.state})`,
          { symbol: c.symbol, score: c.score, state: m.state, normalizedDelta: m.normalizedDelta, cvdSlope: m.cvdSlope, invalidation: c.nearestSupport ?? c.nearestResistance });
      }
      if (m.state === "WEAKENING_BULLISH" || m.state === "WEAKENING_BEARISH") {
        await fire(`${c.instrumentKey}|weakening`, "WARN",
          `${m.state.replace("_", " ").toLowerCase()} on ${c.symbol}: flow no longer confirmed by price`,
          { symbol: c.symbol, reasons: m.reasons, priceAgrees: m.priceAgrees });
      }
      if (m.divergence?.detected) {
        await fire(`${c.instrumentKey}|divergence`, "WARN",
          `Price/CVD divergence candidate on ${c.symbol} — requires structure confirmation`,
          { symbol: c.symbol, note: m.divergence.note, bearish: m.divergence.bearish });
      }
      if (c.entryLocation === "INTO_OPPOSING_ZONE") {
        await fire(`${c.instrumentKey}|zone`, "INFO",
          `${c.symbol} approaching ${c.side === "BUYER" ? "resistance" : "support"} ${c.nextTarget ?? "?"} with ${side.toLowerCase()} pressure`,
          { symbol: c.symbol, target: c.nextTarget, reversalRisk: c.reversalRisk.level });
      }
    }
  }

  /**
   * OI Strike Intelligence for one underlying.
   *
   * Every window is derived from real timestamped observations; nothing is
   * scaled or inferred between windows. Reuses the SHARED Delta/CVD engine
   * and the existing chain view so this tab can never disagree with the rest
   * of the application.
   */
  getOiIntelligence(requestedKey: string): OiIntelligence | { error: string; state: string } {
    const u = this.universe;
    if (!u) return { error: "instrument master still loading", state: "PENDING" };
    const underlyingKey = this.resolveChainKey(requestedKey) ?? requestedKey;
    const capability = u.optionUnderlyings.get(underlyingKey);
    if (!capability) {
      return { error: `${this.displayNameOf(underlyingKey)} has no listed option contracts in the instrument master`, state: "UNSUPPORTED" };
    }
    const view = this.chainViews.get(underlyingKey);
    if (!view) {
      return {
        error: this.tokenStatus === "VALID"
          ? "option chain queued for the next scheduler cycle"
          : "option chains require a valid Upstox access token",
        state: this.tokenStatus === "VALID" ? "PENDING" : "REQUIRES_TOKEN",
      };
    }

    const expiry = view.expiry;
    const now = Date.now();
    const current = this.oiHistory.latest(underlyingKey, expiry);
    const hist = this.oiHistory.stats(underlyingKey, expiry, now);

    // COMPLETE ladder from the chain (oiLevels is untruncated), ascending.
    const ladder = [...new Set(view.oiLevels.map((l) => l.strike))].sort((a, b) => a - b);
    const spot = view.spot;
    const atm = resolveAtm(ladder, spot);
    const interval = inferStrikeInterval(ladder);

    const obsCount = hist.observations;
    const w5 = buildWindow("5-Minute Change in OI", 5 * 60_000, current,
      this.oiHistory.baselineFor(underlyingKey, expiry, 5 * 60_000, now), ladder, 2, obsCount);
    const w15 = buildWindow("15-Minute Change in OI", 15 * 60_000, current,
      this.oiHistory.baselineFor(underlyingKey, expiry, 15 * 60_000, now), ladder, 2, obsCount);

    // Session window uses the persisted SESSION_REF baseline when the series
    // does not reach back to the open; otherwise the earliest observation.
    const sessionRefAt = view.refCapturedAt;
    const earliest = this.oiHistory.earliest(underlyingKey, expiry);
    const sessionBaseline = earliest && sessionRefAt && earliest.t <= sessionRefAt + 60_000 ? earliest : earliest;
    const session = buildWindow("Session Change in OI", Math.max(now - (sessionRefAt ?? now), 0), current, sessionBaseline, ladder, 2, obsCount);
    if (session.status === "OK" && sessionRefAt && sessionBaseline && sessionBaseline.t > sessionRefAt + 5 * 60_000) {
      session.reason += " — series begins after the session reference; shown as change since observation start, not since the open";
    }

    const totalOi = ladder.map((strike) => {
      const s = current?.strikes.get(strike);
      const lvl = view.oiLevels.find((l) => l.strike === strike);
      return { strike, ceOi: s?.ceOi ?? lvl?.ceOi ?? null, peOi: s?.peOi ?? lvl?.peOi ?? null };
    });
    const ceTotal = totalOi.reduce((a, r) => a + (r.ceOi ?? 0), 0);
    const peTotal = totalOi.reduce((a, r) => a + (r.peOi ?? 0), 0);

    // Positioning postures across the focus band, using OI + premium + spot move.
    const band = focusBand(ladder, atm);
    const baseline5 = this.oiHistory.baselineFor(underlyingKey, expiry, 5 * 60_000, now);
    const underlyingChange = current?.spot != null && baseline5?.spot != null ? current.spot - baseline5.spot : null;
    const postures: StrikePosture[] = [];
    for (const strike of band) {
      const c = current?.strikes.get(strike);
      const b = baseline5?.strikes.get(strike);
      if (!c || !b) continue;
      for (const side of ["CE", "PE"] as const) {
        const oiNow = side === "CE" ? c.ceOi : c.peOi;
        const oiThen = side === "CE" ? b.ceOi : b.peOi;
        const pNow = side === "CE" ? c.ceLtp : c.peLtp;
        const pThen = side === "CE" ? b.ceLtp : b.peLtp;
        if (oiNow === null || oiThen === null) continue;
        const oiChange = oiNow - oiThen;
        if (Math.abs(oiChange) < 1) continue;
        const premiumChange = pNow !== null && pThen !== null ? round4(pNow - pThen) : null;
        const { posture, note } = classifyPosture(side, oiChange, premiumChange, underlyingChange);
        if (posture === "NO_CLEAR_POSTURE") continue;
        postures.push({ strike, side, posture, oiChange: round4(oiChange), premiumChange, note });
      }
    }

    // Shared Delta/CVD pressure (identical object the other tabs consume).
    const cvd = this.cvdMomentumFor(underlyingKey, 5);
    const momentum = classifyOiMomentum({
      w5, w15, session,
      underlyingChangePct: underlyingChange !== null && current?.spot ? round4((underlyingChange / current.spot) * 100) : null,
      priceConfirms: cvd && cvd.mode === "ESTIMATED" ? cvd.priceAgrees : null,
      flowPressure: cvd && cvd.mode === "ESTIMATED" ? cvd.pressure : null,
    });

    const zones = buildOiZones({
      totals: totalOi, w5, w15, session, spot, interval,
      timestamps: { current: current?.t ?? null, baseline5m: w5.baselineAt, baseline15m: w15.baselineAt, session: sessionRefAt },
    });

    const ageMs = current ? now - current.t : null;
    const notes: string[] = [
      "OI is open contracts, not traded volume.",
      "High Call OI is not confirmed resistance and high Put OI is not confirmed support — these are OI-derived candidates only.",
      "Positioning labels are probabilistic interpretations of OI + premium + underlying behaviour, never identification of any trader's position.",
    ];
    if (w5.status !== "OK") notes.push(`5-minute window: ${w5.reason}`);
    if (w15.status !== "OK") notes.push(`15-minute window: ${w15.reason}`);

    const byCe = [...totalOi].sort((a, b) => (b.ceOi ?? 0) - (a.ceOi ?? 0)).slice(0, 5);
    const byPe = [...totalOi].sort((a, b) => (b.peOi ?? 0) - (a.peOi ?? 0)).slice(0, 5);

    return {
      underlyingKey,
      symbol: this.displayNameOf(underlyingKey),
      expiry,
      spot,
      atmStrike: atm,
      focusStrikes: band,
      strikeInterval: interval,
      ladder,
      capturedAt: current?.t ?? view.capturedAt,
      windows: { w5, w15, session },
      totalOi,
      totals: { ceOi: ceTotal, peOi: peTotal, pcrOi: ceTotal > 0 ? round4(peTotal / ceTotal) : null },
      concentration: { topCallStrikes: byCe, topPutStrikes: byPe },
      postures,
      momentum,
      zones,
      history: hist,
      dataQuality: {
        status: ageMs === null ? "UNAVAILABLE" : ageMs < 90_000 ? "LIVE" : "STALE",
        ageMs,
        notes,
      },
    };
  }

  /**
   * UNIFIED Support & Resistance for one instrument.
   *
   * Merges the EXISTING engines — `srEngine.buildZones()` structural zones
   * from the cached 5-minute chart analysis, and `oiIntelligence` OI
   * candidates/windows from the cached option chain — into one decision layer
   * producing immediate + primary support and resistance. The chart, S/R Map,
   * OI tab, Trade Finder and alerts all read THIS, so they cannot disagree.
   *
   * Nothing is recomputed here: it reuses already-polled shared state, so no
   * extra provider requests are made.
   */
  getUnifiedSR(instrumentKey: string): UnifiedSR | null {
    const analysis = this.analysisCache.get(`${instrumentKey}|5`)?.payload ?? null;
    const closed = analysis?.candles.filter((c) => c.closed) ?? [];
    const spotFromQuote = this.quotes.get(instrumentKey)?.ltp ?? null;
    const spot = spotFromQuote ?? (closed.length ? closed[closed.length - 1].c : null);
    if (spot === null) return null;

    // OI evidence for this instrument's OWN underlying (never another's)
    const chainKey = this.resolveChainKey(instrumentKey) ?? instrumentKey;
    const oiResult = this.getOiIntelligence(chainKey);
    const oi = "error" in oiResult ? null : oiResult;

    // Shared ESTIMATED Delta/CVD pressure (futures-proxied for spot indices)
    const cvd = this.cvdMomentumFor(instrumentKey, 5);

    const unified = buildUnifiedSR({
      instrumentKey,
      spot,
      structural: analysis?.zones ?? [],
      oiZones: oi?.zones.all ?? [],
      w5: oi?.windows.w5 ?? null,
      w15: oi?.windows.w15 ?? null,
      session: oi?.windows.session ?? null,
      totalOi: oi?.totalOi ?? [],
      postures: oi?.postures ?? [],
      flowPressure: cvd && cvd.mode === "ESTIMATED" ? cvd.pressure : null,
      atr: lastOf(atrSeries(closed, 14)),
      previous: this.unifiedSrCache.get(instrumentKey) ?? null,
      now: Date.now(),
    });
    this.unifiedSrCache.set(instrumentKey, unified);
    return unified;
  }


  /**
   * Multi-timeframe OI evidence for the Trade Finder, built from the SAME
   * OI intelligence the OI tab and unified S/R consume. Each window reports
   * its own availability; an unavailable window contributes nothing.
   */
  private oiTradeContext(instrumentKey: string): OiTradeContext | null {
    const chainKey = this.resolveChainKey(instrumentKey) ?? instrumentKey;
    const res = this.getOiIntelligence(chainKey);
    if ("error" in res) return null;
    const mk = (w: { status: string; reason: string; rows: { ceChange: number | null; peChange: number | null }[] }) => {
      if (w.status !== "OK") {
        return { available: false, reason: w.reason, ceChange: null, peChange: null, bias: 0 as const };
      }
      const ce = w.rows.reduce((a, r) => a + (r.ceChange ?? 0), 0);
      const pe = w.rows.reduce((a, r) => a + (r.peChange ?? 0), 0);
      const scale = Math.max(Math.abs(ce) + Math.abs(pe), 1);
      const norm = (pe - ce) / scale; // put build / call unwind => bullish
      const bias: 1 | -1 | 0 = norm > 0.12 ? 1 : norm < -0.12 ? -1 : 0;
      return { available: true, reason: w.reason, ceChange: round4(ce), peChange: round4(pe), bias };
    };
    const w5 = mk(res.windows.w5);
    const w15 = mk(res.windows.w15);
    const agreement: "ALIGNED" | "CONFLICTING" | "UNKNOWN" =
      !w5.available || !w15.available || (w5.bias === 0 && w15.bias === 0) ? "UNKNOWN"
      : w5.bias !== 0 && w15.bias !== 0 && w5.bias !== w15.bias ? "CONFLICTING"
      : "ALIGNED";
    return {
      w5, w15, session: mk(res.windows.session),
      totalCeOi: res.totals.ceOi,
      totalPeOi: res.totals.peOi,
      agreement,
      momentumState: res.momentum.state,
      postureNotes: res.postures.slice(0, 4).map((p) => `${p.strike} ${p.side}: ${p.note}`),
    };
  }

  /** Buyer/Seller dominance built from the shared scanner + flow + structure. */
  getDominance(topN = 5): DominanceOutput | null {
    // Live scanner when a token is connected, else the degraded EOD scanner —
    // either way we consume the FULL evaluated universe (`allRows`), never
    // the ranked boards (which would cap coverage at the board sizes).
    const sc = this.scanner ?? this.getEodScanner();
    if (!sc) return null;
    const rows = [...new Map(sc.allRows.map((r) => [r.instrumentKey, r])).values()];
    return buildDominance({
      rows,
      structures: this.dominanceStructures(),
      cvd: this.cvdMomentumMap(),
      // true eligible F&O equity universe from the instrument master, so
      // coverage % and the PARTIAL flag are honest
      eligibleUniverse: this.universe?.foEquities.length ?? rows.length,
      now: Date.now(),
      topN,
      minTurnoverCr: 25,
    });
  }

  /** Honest Trade Finder coverage: how much of the universe has been analysed. */
  analysisCoverage() {
    const u = this.universe;
    const eligible = u?.foEquities.length ?? 0;
    const now = Date.now();
    const FRESH = 15 * 60_000;
    let analysed = 0;
    let fresh = 0;
    for (const eq of u?.foEquities ?? []) {
      const at = this.analysisAt.get(eq.instrumentKey);
      if (at) {
        analysed++;
        if (now - at < FRESH) fresh++;
      }
    }
    return {
      eligibleStocks: eligible,
      analysedStocks: analysed,
      freshAnalyses: fresh,
      skipped: this.analysisSkipped.size,
      perCycle: ANALYSIS_STOCKS_PER_CYCLE,
      fullCoverage: eligible > 0 && fresh >= eligible,
      indicesAlwaysAnalysed: true,
    };
  }

  private async analysisLoop(): Promise<void> {
    if (this.analysisBusy) return;
    this.analysisBusy = true;
    try {
      const u = this.universe;
      if (!u) return;
      // Without a token we still run the SAME analysis pipeline on public
      // historical candles (dataQuality: HISTORICAL), at a reduced batch
      // size. Trade Finder therefore covers stocks in degraded mode too —
      // every signal is labelled HISTORICAL, never presented as live.
      const degraded = this.tokenStatus !== "VALID";
      if (degraded) await this.refreshEodIndices();
      const now = Date.now();
      const session = istDateKey(now);
      const board: Signal[] = [];
      const indexMains = [u.indices.NIFTY, u.indices.SENSEX, u.indices.BANKNIFTY].filter(Boolean) as { instrumentKey: string }[];
      // Indices every cycle + a rotating batch of F&O STOCKS so Trade Finder
      // covers the equity universe, not just indices. Each instrument uses
      // ITS OWN candles, zones, chain and flow tracker — never index data.
      const stockBatch = this.nextStockAnalysisBatch(degraded ? 2 : ANALYSIS_STOCKS_PER_CYCLE);
      const flowMap = this.buildFlowConfirmations();
      const targets = [...indexMains.map((i) => i.instrumentKey), ...stockBatch];
      for (const key of targets) {
        const im = { instrumentKey: key };
        try {
          const analysis = await this.getAnalysis(im.instrumentKey, 5);
          if (!analysis || analysis.candles.filter((c) => c.closed).length < 40) {
            this.analysisSkipped.set(im.instrumentKey, "insufficient 5m candle history");
            continue;
          }
          const closed = analysis.candles.filter((c) => c.closed);
          const quote = this.quotes.get(im.instrumentKey) ?? null;
          const dq: DataQuality =
            this.tokenStatus !== "VALID" || !quote || !quote.ltp ? "HISTORICAL"
            : now - quote.localTs > QUOTE_StaleMs() ? "STALE" : "LIVE";
          const tracker = this.trackers.get(im.instrumentKey) ?? null;
          const bars = tracker ? tracker.bars(5) : [];
          const flow = bars.length >= 4 ? flowContext(bars, 6) : null;
          if (flow && bars.length >= 12) {
            flow.divergence = detectCvdDivergence(bars, closed.slice(-bars.length).map((c) => c.c));
          }
          // the instrument's OWN option chain (stocks resolve to their own key)
          const chainKey = this.resolveChainKey(im.instrumentKey) ?? im.instrumentKey;
          const chain = this.chainViews.get(chainKey) ?? null;
          const atr = lastOf(atrSeries(closed, 14)) ?? 0;
          const sigs = deriveSignals({
            instrumentKey: im.instrumentKey,
            timeframeMin: 5,
            candles: analysis.candles,
            structure: analyzeStructure(analysis.candles),
            zones: analysis.zones,
            flow,
            // shared flow confirmation — same object the scanner consumes
            flowConfirm: flowMap.get(im.instrumentKey) ?? null,
            chainCtx: chain ? { pcrOi: chain.pcrOi, maxPain: chain.maxPain } : null,
            // multi-timeframe OI + unified S/R — same shared outputs the
            // OI tab, chart and S/R Map render
            oiCtx: this.oiTradeContext(im.instrumentKey),
            unifiedLevels: (() => {
              const u = this.getUnifiedSR(im.instrumentKey);
              return u ? {
                immediateSupport: u.immediateSupport?.price ?? null,
                primarySupport: u.primarySupport?.price ?? null,
                immediateResistance: u.immediateResistance?.price ?? null,
                primaryResistance: u.primaryResistance?.price ?? null,
              } : null;
            })(),
            atr,
            tickSize: this.metaOf(im.instrumentKey)?.tickSize ?? 0.05,
            dataQuality: dq,
            now,
          });
          this.analysisAt.set(im.instrumentKey, now);
          this.analysisSkipped.delete(im.instrumentKey);
          board.push(...sigs);
          // persist zones for audit history (bounded)
          await this.persistZones(im.instrumentKey, analysis.zones, session);
        } catch (e) {
          this.noteError(`analysis ${im.instrumentKey}`, e);
        }
      }

      // reconcile board vs previous (expire vanished; upsert changed)
      const prevById = new Map(this.signalsBoard.map((s) => [s.id, s]));
      const seen = new Set<string>();
      for (const s of board) {
        seen.add(s.id);
        const prev = prevById.get(s.id);
        if (!prev || prev.status !== s.status || prev.updatedAt !== s.updatedAt) {
          await this.persistSignal(s, session);
        }
      }
      for (const s of this.signalsBoard) {
        if (!seen.has(s.id) && (s.status === "WATCH" || s.status === "ACTIVE")) {
          const expired = { ...s, status: "EXPIRED" as const, updatedAt: now };
          await this.persistSignal(expired, session);
          board.push(expired);
        }
      }
      this.signalsBoard = board.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      // dominance / CVD alerts (cooldown + dedupe inside)
      await this.emitFlowAlerts().catch((e) => this.noteError("flow alerts", e));
    } finally {
      this.analysisBusy = false;
    }
  }

  private async persistZones(key: string, zonesList: ChartAnalysis["zones"], session: string) {
    try {
      for (const z of zonesList.slice(0, 10)) {
        await db.insert(zonesTable).values({
          id: `${z.id}|${session}`,
          instrumentKey: key, timeframeMin: z.timeframeMin, side: z.side,
          lower: z.lower, upper: z.upper, mid: z.mid,
          provenanceGroup: z.provenanceGroup, confirmationStatus: z.confirmationStatus,
          state: z.state, score: z.score,
          breakdown: z.breakdown as unknown as Record<string, unknown>[],
          sources: z.sources as unknown as Record<string, unknown>[],
          invalidation: z.invalidation, sessionDate: session, updatedAt: new Date(),
        }).onConflictDoUpdate({
          target: zonesTable.id,
          set: { state: z.state, score: z.score, updatedAt: new Date(), side: z.side },
        });
      }
    } catch (e) {
      this.noteError("persist zones", e);
    }
  }

  private async persistSignal(s: Signal, session: string) {
    try {
      await db.insert(signalsTable).values({
        id: s.id,
        instrumentKey: s.instrumentKey, timeframeMin: s.timeframeMin,
        direction: s.direction, scenario: s.scenario, status: s.status,
        entry: s.entry, stop: s.stop, targets: s.targets as unknown as Record<string, unknown>[],
        rr: s.rr, score: s.score, breakdown: s.breakdown as unknown as Record<string, unknown>[],
        trace: s.trace as unknown as Record<string, unknown>,
        capabilityTags: s.capabilityTags as unknown as string[],
        dataQuality: s.dataQuality, sessionDate: session, updatedAt: new Date(s.updatedAt),
      }).onConflictDoUpdate({
        target: signalsTable.id,
        set: { status: s.status, score: s.score, updatedAt: new Date(s.updatedAt) },
      });
      if (s.status === "ACTIVE" && !this.activeAlerted.has(s.id)) {
        this.activeAlerted.add(s.id);
        await this.alert("INFO", `signal ACTIVE: ${s.scenario} ${s.direction} ${s.instrumentKey}`, { entry: s.entry, stop: s.stop, targets: s.targets });
      }
    } catch (e) {
      this.noteError("persist signal", e);
    }
  }

  private activeAlerted = new Set<string>();

  // --------------------------------------------------------------- status

  connectionState(): "LIVE" | "STALE" | "AWAITING_TOKEN" | "DISCONNECTED" {
    if (this.tokenStatus !== "VALID") return "AWAITING_TOKEN";
    if (!this.lastPollAt) return "DISCONNECTED";
    const age = Date.now() - this.lastPollAt;
    if (age <= QUOTE_STALE_MS) return "LIVE";
    if (age <= 120_000) return "STALE";
    return "DISCONNECTED";
  }

  getStatus() {
    const now = Date.now();
    const p = istParts(now);
    const eqTotal = this.universe?.foEquities.length ?? 0;
    const fresh = [...this.quotes.values()].filter((q) => q.instrumentKey.startsWith("NSE_EQ") && q.ltp !== null && now - q.localTs < 25_000).length;
    const staleEq = [...this.quotes.values()].filter((q) => q.instrumentKey.startsWith("NSE_EQ") && now - q.localTs >= 25_000).length;
    return {
      tokenStatus: this.tokenStatus,
      profileName: this.profile?.userName ?? null,
      connection: this.connectionState(),
      marketPhase: marketPhase(now),
      istClock: `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`,
      istDate: istDateKey(now),
      startedAt: this.startedAt,
      lastPollAt: this.lastPollAt,
      lastChainAt: this.lastChainAt,
      counters: this.counters,
      universe: this.universe
        ? {
            loaded: true,
            foStockCount: this.universe.foEquities.length,
            rawCount: this.universe.countRaw,
            indices: Object.fromEntries(Object.entries(this.universe.indices).map(([k, v]) => [k, v?.instrumentKey ?? null])),
            error: null,
          }
        : { loaded: false, foStockCount: 0, rawCount: 0, indices: {}, error: this.universeError },
      capabilities: buildCapabilityMatrix(this.tokenStatus === "VALID"),
      sessionElapsed: sessionElapsedFraction(now),
      transport: {
        mode: "REST_API_POLLING",
        quoteIntervalMs: effectiveQuoteMs(this.pollConfig),
        chainIntervalMs: this.pollConfig.chainMs,
        scannerIntervalMs: this.pollConfig.scannerMs,
        quoteBatch: this.pollConfig.quoteBatch,
        rateRps: this.pollConfig.rateRps,
        rateLimitWaits: this.limiter.rateLimitEvents,
        rateLimitWaitedMs: this.limiter.totalWaitedMs,
        cycles: this.pollCycles,
        failedCycles: this.pollCyclesFailed,
      },
      secrets: { storage: "aes-256-gcm", keySource: secretKeySource() },
      focusKey: this.focusKey,
      coverage: {
        eligibleStocks: eqTotal,
        freshEquityQuotes: fresh,
        staleEquityQuotes: staleEq,
        lastCycleRequested: this.coverage?.requested ?? 0,
        lastCycleReturned: this.coverage?.returned ?? 0,
        lastCycleValidLtp: this.coverage?.validLtp ?? 0,
        deferredToNextRotation: this.coverage?.deferred ?? 0,
        coveragePct: this.coverage?.coveragePct ?? 0,
        fullCoverage: this.coverage?.fullCoverage ?? false,
        uncovered: Math.max(0, eqTotal - fresh),
        lastUpdate: this.lastPollAt,
        lastError: this.counters.lastError,
      },
      scanAt: this.scanAt || null,
      scan: this.scanState,
      diagnostics: this.diags.slice(-Engine.MAX_DIAGS),
    };
  }

  indexCards() {
    const u = this.universe;
    if (!u) return [];
    const out: {
      key: string; name: string; spot: number | null; changePct: number | null;
      eodDate: string | null;
      futLtp: number | null; futChangePct: number | null; futOi: number | null; interp: string | null;
      quality: DataQuality; chain: { pcrOi: number | null; pcrVol: number | null; maxPain: number | null; expiry: string | null } | null;
    }[] = [];
    const defs: [string, "NIFTY" | "SENSEX" | "BANKNIFTY", string][] = [
      ["NIFTY 50", "NIFTY", "NIFTY"],
      ["SENSEX", "SENSEX", "SENSEX"],
      ["NIFTY BANK", "BANKNIFTY", "BANKNIFTY"],
    ];
    for (const [label, idxKey, futName] of defs) {
      const idx = u.indices[idxKey];
      if (!idx) continue;
      const q = this.quotes.get(idx.instrumentKey) ?? null;
      const fut = u.futures.get(futName)?.[0] ?? null;
      const fq = fut ? this.quotes.get(fut.instrumentKey) ?? null : null;
      // Degraded fallback: real prior-session EOD close when no live quote exists
      const eod = this.eodIdx.get(idx.instrumentKey) ?? null;
      const spot = q?.ltp ?? eod?.close ?? null;
      const changePct =
        q && q.ltp !== null && q.close ? ((q.ltp - q.close) / q.close) * 100 : eod?.changePct ?? null;
      const futChangePct = fq && fq.ltp !== null && fq.close ? ((fq.ltp - fq.close) / fq.close) * 100 : null;
      const session = istDateKey(Date.now());
      const ref = fut ? this.refSnapshots.get(fut.instrumentKey) : undefined;
      const refOi = fut && ref ? ref.oi.get(fut.instrumentKey) : undefined;
      const oiChgPct = fq?.oi != null && refOi ? ((fq.oi - refOi) / refOi) * 100 : null;
      const itpw = fut ? futuresInterpretation(futChangePct, oiChgPct) : null;
      void itpw;
      const interp = futChangePct !== null && oiChgPct !== null ? (futuresInterpretation(futChangePct, oiChgPct)?.label ?? null) : null;
      const chain = this.chainViews.get(idx.instrumentKey) ?? null;
      out.push({
        key: idx.instrumentKey, name: label, spot,
        changePct: changePct !== null ? Math.round(changePct * 100) / 100 : null,
        eodDate: eod?.date ?? null,
        futLtp: fq?.ltp ?? null, futChangePct: futChangePct !== null ? Math.round(futChangePct * 100) / 100 : null,
        futOi: fq?.oi ?? null, interp,
        quality: q ? this.freshness(q.localTs, Date.now()) : eod ? "HISTORICAL" : "UNAVAILABLE",
        chain: chain ? { pcrOi: chain.pcrOi, pcrVol: chain.pcrVol, maxPain: chain.maxPain, expiry: chain.expiry } : null,
      });
    }
    return out;
  }

  chainOptionsFor(key: string): ChainAnalytics | null {
    return this.chainViews.get(key) ?? null;
  }

  flowFor(key: string, barMin = 5) {
    const t = this.trackers.get(key);
    if (!t) return null;
    const bars = t.bars(barMin);
    const lastBar = bars[bars.length - 1];
    const attribution = t.attribution();
    const closes = bars.map((b) => {
      const ps = Object.keys(b.perPrice).map(Number).filter((p) => Number.isFinite(p));
      return ps.length ? ps[ps.length - 1] : 0;
    }).filter((p) => p > 0);
    const confirm = flowConfirmation(bars, attribution, closes, Date.now(), 6);
    return {
      mode: "ESTIMATED" as const,
      transport: "REST_POLLED" as const,
      reset: t.resetLabel(),
      tickCount: t.tickCount,
      attribution,
      confirm: {
        status: confirm.status,
        available: confirm.available,
        reason: confirm.reason,
        deltaRatio: confirm.deltaRatio,
        cvdSlope: confirm.cvdSlope,
        cvdNow: confirm.cvdNow,
        label: confirm.label,
        divergence: confirm.divergence,
      },
      bars: bars.slice(-120),
      footprint: lastBar ? { barT: lastBar.t, rows: footprintRows(lastBar).slice(0, 40) } : null,
    };
  }

  async recentAlerts() {
    try {
      return await db.select().from(alertsTable).orderBy(desc(alertsTable.createdAt)).limit(20);
    } catch {
      return [];
    }
  }
}

function QUOTE_StaleMs() {
  return QUOTE_STALE_MS;
}

export {};

// Global singleton (survives HMR in dev).
const g = globalThis as typeof globalThis & { __fnoEngine?: Engine };
export function engine(): Engine {
  if (!g.__fnoEngine) g.__fnoEngine = new Engine();
  return g.__fnoEngine;
}

export async function ensureBoot(): Promise<Engine> {
  const e = engine();
  await e.boot();
  return e;
}
