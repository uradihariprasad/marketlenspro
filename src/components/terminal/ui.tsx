"use client";

// ---------------------------------------------------------------------------
// Client-side view types (mirror of server payloads; the server lib is never
// imported into the browser bundle)
// ---------------------------------------------------------------------------

export interface StatusPayload {
  tokenStatus: "NONE" | "VALID" | "EXPIRED" | "INVALID";
  profileName: string | null;
  connection: "LIVE" | "STALE" | "AWAITING_TOKEN" | "DISCONNECTED";
  marketPhase: "WEEKEND" | "PRE_OPEN" | "OPEN" | "POST_CLOSE";
  istClock: string;
  istDate: string;
  startedAt: number;
  lastPollAt: number | null;
  lastChainAt: number | null;
  counters: { quotesReceived: number; quotesProcessed: number; quotesDropped: number; chainFetches: number; candleFetches: number; errors: number; lastError: string | null; lastErrorAt: number };
  universe: { loaded: boolean; foStockCount: number; rawCount: number; indices: Record<string, string | null>; error: string | null };
  capabilities: { feature: string; status: string; method: string; limitation: string }[];
  sessionElapsed: number;
  transport?: {
    mode: string;
    quoteIntervalMs: number;
    chainIntervalMs: number;
    scannerIntervalMs: number;
    quoteBatch: number;
    rateRps: number;
    rateLimitWaits: number;
    rateLimitWaitedMs: number;
    cycles: number;
    failedCycles: number;
  };
  secrets?: { storage: string; keySource: string };
  focusKey?: string | null;
  /** Phase 6.17 / 7.15 honest coverage + provider diagnostics */
  coverage?: {
    eligibleStocks: number;
    freshEquityQuotes: number;
    staleEquityQuotes: number;
    lastCycleRequested: number;
    lastCycleReturned: number;
    lastCycleValidLtp: number;
    deferredToNextRotation: number;
    coveragePct: number;
    fullCoverage: boolean;
    uncovered: number;
    lastUpdate: number | null;
    lastError: string | null;
  };
  scanAt?: number | null;
  /** Coordinated scan-cycle state (shared by auto + manual scans). */
  scan?: {
    status: "IDLE" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED" | "RATE_LIMITED";
    startedAt: number | null; finishedAt: number | null; lastSuccessAt: number | null;
    durationMs: number | null; trigger: "AUTO" | "MANUAL" | null;
    evaluated: number; failed: number; error: string | null; cycles: number;
  };
  diagnostics?: { t: number; endpoint: string; http: number | null; ms: number; requested: number; returned: number; validLtp: number; missing: number; note: string }[];
}

export interface IndexCard {
  key: string;
  name: string;
  spot: number | null;
  changePct: number | null;
  eodDate?: string | null;
  futLtp: number | null;
  futChangePct: number | null;
  futOi: number | null;
  interp: string | null;
  quality: string;
  chain: { pcrOi: number | null; pcrVol: number | null; maxPain: number | null; expiry: string | null } | null;
}

export interface ScannerRow {
  instrumentKey: string;
  symbol: string;
  ltp: number;
  changePct: number;
  volumeCum: number | null;
  turnoverCr: number | null;
  rvol: number | null;
  rvolMode: string;
  atrPct: number | null;
  rsVsNifty: number | null;
  vwapPos: "ABOVE" | "BELOW" | null;
  futInterp: string | null;
  proximity: string | null;
  flow?: { status: string; available: boolean; reason: string; deltaRatio: number | null; cvdSlope: number | null; attributionPct: number; score: number; label: string } | null;
  momentum?: {
    classification: string;
    direction: 1 | -1 | 0;
    strength: number;
    participation: number;
    atrMove: number | null;
    breakdown: { k: string; v: number }[];
  };
  score: number;
  reasons: string[];
  exclusions: string[];
  quality: string;
  changeBasis?: string;
  changeExact?: boolean;
}

export interface ScannerPayload {
  asOf: number;
  /** Every instrument the scanner evaluated this cycle (not just leaders). */
  allRows?: ScannerRow[];
  bullish: ScannerRow[];
  bearish: ScannerRow[];
  rvolLeaders: ScannerRow[];
  liquid: ScannerRow[];
  rejected: { symbol: string; reason: string }[];
  universeSize: number;
  notes: string[];
  coverage?: {
    eligible: number; refreshed: number; stale: number; missingData: number;
    evaluated: number; flowConfirmed: number; flowUnavailable: number;
    qualifying: number; lastUpdate: number;
  };
}

export interface SignalPayload {
  id: string;
  instrumentKey: string;
  timeframeMin: number;
  direction: "LONG" | "SHORT";
  scenario: string;
  status: "WATCH" | "ACTIVE" | "INVALIDATED" | "EXPIRED";
  grade?: "GOOD_TRADE" | "POSSIBLE_TRADE";
  entry: number | null;
  stop: number | null;
  targets: number[];
  rr: number | null;
  score: number;
  breakdown: { k: string; v: number }[];
  confirmations: string[];
  pending: string[];
  invalidationRule: string;
  trace: { rules: string[]; inputs: Record<string, string | number | null> };
  capabilityTags: string[];
  dataQuality: string;
  createdAt: number;
  updatedAt: number;
  validUntil: number;
}

export interface ChainRowPayload {
  strike: number;
  ceOi: number; peOi: number;
  ceOiChg: number | null; peOiChg: number | null;
  ceOiChgPrev?: number | null; peOiChgPrev?: number | null; // vs previous chain snapshot (~60s)
  ceVol: number; peVol: number;
  ceLtp: number | null; peLtp: number | null;
  ceIv: number | null; peIv: number | null;
  ceTheta: number | null; peTheta: number | null;
  ceBid: number | null; ceAsk: number | null;
  peBid: number | null; peAsk: number | null;
}

export interface ChainPayload {
  underlyingKey: string;
  expiry: string;
  spot: number | null;
  capturedAt: number;
  mode: string;
  atmStrike: number | null;
  pcrOi: number | null;
  pcrVol: number | null;
  maxPain: number | null;
  totalCeOi: number;
  totalPeOi: number;
  refCapturedAt: number | null;
  rows: ChainRowPayload[];
  notes: string[];
}

export interface InstrumentOption { instrumentKey: string; label: string; tick: number }
export interface InstrumentsPayload {
  indices: InstrumentOption[];
  futures: InstrumentOption[];
  stocks: InstrumentOption[];
}

export interface AlertRow { id: number; level: string; message: string; createdAt: string }

export interface ChainCatalogEntry {
  underlyingKey: string;
  symbol: string;
  isIndex: boolean;
  expiries: string[];
  state: "LOADED" | "PENDING" | "UNSUPPORTED" | "FAILED";
  at: number | null;
  note: string;
}

export interface ChainResponse {
  ok: boolean;
  state: string;
  underlyingKey: string;
  symbol: string;
  expiries?: string[];
  isIndex?: boolean;
  chain?: ChainPayload;
  ageMs?: number;
  note?: string | null;
  error?: string | null;
}

export interface TerminalPayload {
  status: StatusPayload;
  indexCards: IndexCard[];
  scanner: ScannerPayload | null;
  chainCatalog?: ChainCatalogEntry[];
  chainStats?: { total: number; loaded: number; pending: number; failed: number; unsupported: number };
  analysisCoverage?: { eligibleStocks: number; analysedStocks: number; freshAnalyses: number; skipped: number; perCycle: number; fullCoverage: boolean; indicesAlwaysAnalysed: boolean };
  /** Degraded-mode momentum snapshot from provider DAILY candles (labelled EOD). */
  eodScanner?: ScannerPayload | null;
  signals: SignalPayload[];
  chains: Record<string, ChainPayload>;
  instruments: InstrumentsPayload;
  alerts: AlertRow[];
}

export interface ZonePayload {
  id: string;
  side: string;
  lower: number;
  upper: number;
  mid: number;
  provenanceGroup: "STRUCTURAL" | "OI_CANDIDATE";
  confirmationStatus: string;
  state: string;
  score: number;
  breakdown: { k: string; v: number }[];
  sources: { kind: string; detail: string; t: number | null; weight: number }[];
  touches: { t: number; price: number; reaction: string }[];
  invalidation: number;
}

export interface CandlePayload { t: number; o: number; h: number; l: number; c: number; v: number; closed: boolean }

export interface FlowBarPayload { t: number; buyVol: number; sellVol: number; untracedVol?: number; delta: number; cvd: number; perPrice: Record<string, { buy: number; sell: number }> }

export interface UnifiedLevelPayload {
  id: string;
  role: "IMMEDIATE_SUPPORT" | "PRIMARY_SUPPORT" | "IMMEDIATE_RESISTANCE" | "PRIMARY_RESISTANCE";
  side: "SUPPORT" | "RESISTANCE";
  price: number; lower: number; upper: number; distancePct: number;
  state: string; score: number;
  provenance: "STRUCTURAL" | "OI_CANDIDATE" | "CONFLUENCE";
  priceConfirmed: boolean; confirmation: string;
  evidence: { k: string; detail: string; weight: number; source: string }[];
  contributingStrikes: number[];
  invalidation: string; updatedAt: number;
}

export interface UnifiedSRPayload {
  instrumentKey: string;
  spot: number | null;
  immediateSupport: UnifiedLevelPayload | null;
  primarySupport: UnifiedLevelPayload | null;
  immediateResistance: UnifiedLevelPayload | null;
  primaryResistance: UnifiedLevelPayload | null;
  all: UnifiedLevelPayload[];
  unavailable: { support: string | null; resistance: string | null };
  notes: string[];
  updatedAt: number;
}

export interface ChartPayload {
  ok: boolean;
  error?: string;
  displayName?: string;
  connection?: string;
  tokenStatus?: string;
  quote?: { ltp: number | null; changePct: number | null; atp: number | null; oi: number | null; volumeCum: number | null; close: number | null; bids: { p: number; q: number }[]; asks: { p: number; q: number }[]; depthLevels: number; quality: string; localTs: number } | null;
  chain?: { underlyingKey: string; expiry: string; pcrOi: number | null; pcrVol: number | null; maxPain: number | null; atmStrike: number | null; rows: ChainRowPayload[]; capturedAt: number; refCapturedAt: number | null; notes: string[] } | null;
  asOf?: number;
  /** Shared ESTIMATED CVD momentum (identical to the dominance tab's values). */
  cvd?: {
    state: string; pressure: number; lastDelta: number | null;
    normalizedDelta: number | null; deltaAcceleration: number | null;
    deltaConsistency: number | null; deltaVsTotalVolume: number | null;
    cvdNow: number | null; cvdSlope: number | null; cvdAcceleration: number | null;
    priceChangeInWindow: number | null; priceAgrees: boolean;
    divergence: { detected: boolean; bearish: boolean; note: string } | null;
    basis: string; reasons: string[]; mode: string;
    sourceKey?: string; sourceType?: string; sourceLabel?: string | null;
    isProxy?: boolean; proxyReason?: string;
  } | null;
  /** Unified immediate/primary S/R produced server-side (never recomputed in the UI). */
  unifiedSR?: UnifiedSRPayload | null;
  flowSource?: {
    requestedKey: string; sourceKey: string; sourceType: string;
    sourceLabel: string | null; contractExpiry: string | null;
    isProxy: boolean; reason: string;
  } | null;
  analysis?: {
    quality: string;
    candles: CandlePayload[];
    indicators: { ema9: (number | null)[]; ema21: (number | null)[]; ema50: (number | null)[]; vwap: (number | null)[]; rsi14: (number | null)[]; atr14: (number | null)[] };
    structure: { type: string; level: number; t: number; confirmedAt: number; label?: string }[];
    range: { active: boolean; low: number; high: number; bars: number } | null;
    zones: ZonePayload[];
    profile: { mode: string; poc: number | null; vah: number | null; val: number | null; hvn: number[]; lvn: number[] } | null;
    flow: { mode: string; reset: string; bars: FlowBarPayload[] } | null;
    notes: string[];
  };
  flow?: { mode: string; reset: string; tickCount: number; bars: FlowBarPayload[] } | null;
}

// ---------------------------------------------------------------------------

export function fmtNum(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtCnt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e7) return `${sign}${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${sign}${(a / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}k`;
  return `${sign}${Math.round(a)}`;
}

export function fmtIst(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms + 5.5 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}

export function Color({ v, suffix = "" }: { v: number | null | undefined; suffix?: string }) {
  if (v === null || v === undefined) return <span className="text-slate-500">—</span>;
  const cls = v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "text-slate-400";
  return <span className={`mono ${cls}`}>{v > 0 ? "+" : ""}{v.toFixed(2)}{suffix}</span>;
}

export function CapTag({ status }: { status: string }) {
  return <span className={`tag ${status.toLowerCase()}`}>{status.replace(/_/g, " ")}</span>;
}

export function QualityPill({ q }: { q: string }) {
  const cls = q === "LIVE" ? "live" : q === "STALE" ? "stale" : "off";
  return (
    <span className="pill" style={{ color: q === "LIVE" ? "var(--green)" : q === "STALE" ? "var(--amber)" : "var(--red)" }}>
      <span className={`dot ${cls}`} />
      {q}
    </span>
  );
}

export function NoteList({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <div className="mt-3 space-y-1">
      {notes.map((n, i) => (
        <p key={i} className="text-[11px] leading-relaxed text-slate-500">
          ▸ {n}
        </p>
      ))}
    </div>
  );
}
