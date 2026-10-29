/**
 * Canonical, provider-independent market-data contract and session/time
 * semantics for the F&O intelligence system.
 *
 * Timestamp semantics (rule 6 / 13):
 *  - All epoch values are UNIX epoch MILLISECONDS (UTC-based).
 *  - `exchangeTs` = timestamp supplied by the exchange/provider (Upstox sends
 *    IST-based ISO strings for candles; quotes carry `timestamp` /
 *    `last_trade_time`). `localTs` = server receive time. They are kept
 *    separate end-to-end and never conflated.
 *  - Session boundaries are computed in Asia/Kolkata WITHOUT a tz library by
 *    evaluating wall-clock components at (epochMs + IST_OFFSET).
 */

// ---------------------------------------------------------------- time utils

export const IST_OFFSET_MS = 5.5 * 3_600_000;
export const SESSION_OPEN_MIN = 9 * 60 + 15; // 09:15 IST
export const SESSION_CLOSE_MIN = 15 * 60 + 30; // 15:30 IST (NSE/BSE equity & F&O)
export const SESSION_LENGTH_MIN = SESSION_CLOSE_MIN - SESSION_OPEN_MIN; // 375

export function istParts(t: number) {
  const d = new Date(t + IST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth(),
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    wd: d.getUTCDay(),
  };
}

/** YYYY-MM-DD in IST for a given epoch ms. */
export function istDateKey(t: number): string {
  const p = istParts(t);
  const m = String(p.mo + 1).padStart(2, "0");
  const dd = String(p.d).padStart(2, "0");
  return `${p.y}-${m}-${dd}`;
}

export function istMinutesOfDay(t: number): number {
  const p = istParts(t);
  return p.hh * 60 + p.mm;
}

function istEpoch(dateKey: string, minutesOfDay: number): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 0, minutesOfDay) - IST_OFFSET_MS;
}

export function sessionOpenTs(dateKey: string): number {
  return istEpoch(dateKey, SESSION_OPEN_MIN);
}
export function sessionCloseTs(dateKey: string): number {
  return istEpoch(dateKey, SESSION_CLOSE_MIN);
}

export type MarketPhase = "WEEKEND" | "PRE_OPEN" | "OPEN" | "POST_CLOSE";

export function marketPhase(t = Date.now()): MarketPhase {
  const p = istParts(t);
  if (p.wd === 0 || p.wd === 6) return "WEEKEND";
  const m = p.hh * 60 + p.mm;
  if (m < SESSION_OPEN_MIN) return "PRE_OPEN";
  if (m <= SESSION_CLOSE_MIN) return "OPEN";
  return "POST_CLOSE";
}

/** Fraction of the trading session elapsed, clamped to (0, 1]. */
export function sessionElapsedFraction(t = Date.now()): number {
  const m = istMinutesOfDay(t);
  const elapsed = Math.min(Math.max(m - SESSION_OPEN_MIN, 1), SESSION_LENGTH_MIN);
  return elapsed / SESSION_LENGTH_MIN;
}

// ------------------------------------------------------------------ quality

export type DataQuality = "LIVE" | "STALE" | "PARTIAL" | "UNAVAILABLE" | "HISTORICAL";
export type CalcMode = "EXACT" | "ESTIMATED" | "APPROXIMATE" | "PROVIDER" | "UNAVAILABLE";

export interface CapabilityEntry {
  feature: string;
  status: CalcMode | "REQUIRES_TOKEN";
  method: string;
  limitation: string;
}

/**
 * Honest capability matrix (rules 15 & 18). Upstox REST polling does NOT
 * provide executed-trade aggressor classification, so exact Delta/CVD and
 * bid/ask footprints are UNAVAILABLE; estimated variants are clearly
 * labelled. Upstox REST provides no executed-trade aggressor classification
 * and no trade ids, so the estimation gate is unavoidable on this provider.
 */
export function buildCapabilityMatrix(hasToken: boolean): CapabilityEntry[] {
  const tokenGate = (entry: Omit<CapabilityEntry, "status"> & { status: CalcMode }): CapabilityEntry =>
    hasToken ? entry : { ...entry, status: "REQUIRES_TOKEN", limitation: entry.limitation + " — Upstox access token not provided." };
  return [
    {
      feature: "OHLCV candles (index & equity)",
      status: "EXACT",
      method: "Upstox Historical Candle API v2 (provider exchange timestamps, IST session). 1-minute base, deterministically resampled to 2/5/10/15/30-minute.",
      limitation: "Intra-day history available for the current and prior sessions; index candles carry zero volume.",
    },
    { feature: "Indicators (EMA/RSI/MACD/ATR/VWAP)", status: "EXACT", method: "Computed from validated closed candles; VWAP resets each session; warm-up periods enforced.", limitation: "VWAP requires volume — UNAVAILABLE for raw index instruments (uses futures proxy where noted)." },
    tokenGate({ feature: "Live quotes / LTP / session volume (full F&O universe)", status: "EXACT", method: "Upstox REST Market Quote API v2 (/v2/market-quote/quotes) polled every 10s (env POLL_QUOTES_MS) for the complete eligible universe in ≤100-key batches: spot indices, index futures, every F&O equity and current-month stock futures. Rate-limited by a token-bucket scheduler; the universe rotates transparently if a cycle would exceed the request budget. No WebSocket is used.", limitation: "Polling returns snapshots, not every trade. STALE flag raised after 25s without refresh. A partial cycle is reported as partial — never as full coverage." }),
    tokenGate({ feature: "Delta / CVD", status: "ESTIMATED", method: "Tick-rule estimation (uptick=buy, downtick=sell, carry-last on unchanged) over REST poll-level ltp/volume increments; aggregated per bar; session reset 09:15 IST; cumulative-volume resets and duplicate responses handled.", limitation: "NOT trade-based aggressor Delta. Upstox REST carries no trade-id or aggressor flag, so exact Delta is impossible on this provider. The 10s poll cadence merges opposing trades inside an interval — a directional proxy only." }),
    tokenGate({ feature: "Footprint (bid/ask by price)", status: "ESTIMATED", method: "Same tick-rule increments bucketed at observed LTP levels within each bar.", limitation: "Approximate ladder, not exchange trade prints. Missing trades inside a poll interval are unobservable." }),
    { feature: "Aggressor-side classification (exact)", status: "UNAVAILABLE", method: "—", limitation: "Upstox REST quote packets carry no executed-trade aggressor field and no trade sequence ids on this surface." },
    tokenGate({ feature: "Option chain OI / Greeks", status: "PROVIDER", method: "Upstox Option Chain API v2, nearest expiry; intraday ΔOI computed vs timestamped SESSION_REF snapshots stored in PostgreSQL.", limitation: "Greeks/IV are provider values; provider prev-OI semantics (prior-day reference) kept distinct from intraday ΔOI." }),
    { feature: "Volume Profile (POC/VAH/VAL)", status: "APPROXIMATE", method: "Candle OHLCV profile: volume allocated across candle range with triangular weighting centered on the typical price (H+L+C)/3, tick-aligned bins; 70% value area expanded from POC.", limitation: "Not an exact trade-derived profile; allocation is an approximation. UNAVAILABLE for pure index candles (zero volume) — futures proxy used where enabled." },
    { feature: "Structure / S-R zones", status: "EXACT", method: "Pivot-confirmed swings (3-bar right confirmation, no look-ahead), BOS/CHoCH, consolidation boundaries, prev-session levels, merged with ATR-aware widths.", limitation: "OI-only strikes remain CANDIDATE provenance until qualifying price action confirms them." },
    { feature: "Historical tick replay", status: "UNAVAILABLE", method: "—", limitation: "Upstox REST polling provides no tick/trade history for replay; poll-increment logs persist in-memory only." },
  ];
}

// ------------------------------------------------------------- domain models

export interface Candle {
  /** Candle OPEN time, epoch ms (provider timestamp, IST-aligned session buckets). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Contracts/shares in this bar. 0 for index instruments. */
  v: number;
  /** Provider OI for the bar when supplied (futures daily); else undefined. */
  oi?: number;
  /** False while the bar is still forming (never mixed with closed bars for signals). */
  closed: boolean;
}

export interface InstrumentMeta {
  instrumentKey: string;
  tradingSymbol: string;
  name: string;
  segment: string; // NSE_EQ | NSE_FO | BSE_FO | NSE_INDEX | BSE_INDEX
  instrumentType: string; // FUTSTK | FUTIDX | OPTIDX | EQ | INDEX ...
  underlyingKey?: string;
  underlyingSymbol?: string;
  expiry?: number; // epoch ms
  strike?: number;
  optionType?: "CE" | "PE";
  lotSize?: number;
  tickSize: number;
  weekly?: boolean;
}

export interface Quote {
  instrumentKey: string;
  source: "UPSTOX_REST_POLL";
  exchangeTs: number | null; // provider `timestamp` (ms) when given
  lastTradeTs: number | null; // provider `last_trade_time` (ms) when given
  localTs: number; // receive time
  ltp: number | null;
  ltq: number | null;
  volumeCum: number | null; // session cumulative volume from provider
  oi: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  /**
   * Provider `ohlc.close`. WARNING: in the documented full-market-quote
   * response this can equal `last_price` (the day's latest) rather than the
   * previous session's close, so it must NOT be used as the change baseline on
   * its own. Prefer `netChange`, which is the provider's own change field.
   */
  close: number | null;
  /** Provider `net_change` — the authoritative change vs previous close. */
  netChange: number | null;
  atp: number | null;
  bid: { p: number; q: number } | null;
  ask: { p: number; q: number } | null;
  /** Top-of-book arrays (up to 5 levels) when the transport provides depth. */
  bids?: { p: number; q: number }[];
  asks?: { p: number; q: number }[];
  depthLevels: 0 | 1 | 5;
  quality: DataQuality;
}

export function alignToTick(p: number, tick: number): number {
  if (!tick || tick <= 0 || !Number.isFinite(tick)) return round4(p);
  return round4(Math.round(p / tick) * tick);
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ---------------------------------------------------------------- structure

export type StructureEventType =
  | "PIVOT_HIGH"
  | "PIVOT_LOW"
  | "BOS_UP"
  | "BOS_DOWN"
  | "CHOCH_UP"
  | "CHOCH_DOWN";

export interface StructureEvent {
  type: StructureEventType;
  level: number;
  /** Logical time of the pivoted/structure break bar. */
  t: number;
  /** Time at which the event became knowable WITHOUT look-ahead (confirmation). */
  confirmedAt: number;
  /** Sequence label for swings. */
  label?: "HH" | "HL" | "LH" | "LL";
}

export interface RangeInfo {
  active: boolean;
  low: number;
  high: number;
  sinceT: number;
  bars: number;
}

/** A single price observation relevant to a zone. */
export interface ZoneSource {
  kind:
    | "SWING"
    | "CONSOLIDATION"
    | "PREV_SESSION"
    | "PROFILE_POC"
    | "PROFILE_VAH"
    | "PROFILE_VAL"
    | "PROFILE_HVN"
    | "PROFILE_LVN"
    | "OPTION_OI"
    | "OPTION_OI_CHANGE"
    | "VWAP";
  detail: string;
  t: number | null;
  weight: number;
}

export interface ZoneTouch {
  t: number;
  price: number;
  reaction: "BOUNCE" | "REJECTION" | "PASS";
}

export interface Zone {
  id: string;
  instrumentKey: string;
  timeframeMin: number;
  side: "SUPPORT" | "RESISTANCE" | "BOTH";
  lower: number;
  upper: number;
  mid: number;
  provenanceGroup: "STRUCTURAL" | "OI_CANDIDATE";
  confirmationStatus: "CANDIDATE" | "CONFIRMED";
  /**
   * Lifecycle state. CONFIRMED-ness lives in `confirmationStatus`; this is the
   * live behavioural state of the level.
   */
  state:
    | "CANDIDATE"       // proposed, no interaction yet
    | "DEVELOPING"      // touched but no decisive reaction yet
    | "CONFIRMED"       // at least one confirmed reaction/rejection
    | "STRENGTHENING"   // repeated successful defences
    | "WEAKENING"       // repeated tests with shrinking reaction
    | "BREAKOUT_RISK"   // price pressing the upper bound
    | "BREAKDOWN_RISK"  // price pressing the lower bound
    | "BROKEN"          // price accepted beyond the zone
    | "RECLAIMED";      // broke, then price returned and held
  score: number; // deterministic confluence score — NOT a win probability
  breakdown: { k: string; v: number }[];
  sources: ZoneSource[];
  touches: ZoneTouch[];
  invalidation: number; // price whose sustained trade beyond voids the zone
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------- orderflow

export interface FlowTick {
  t: number; // localTs of poll (no exchange trade ts available)
  price: number;
  volDelta: number; // cumulative-volume increment between polls
  /**
   * ESTIMATED aggressor side by tick rule. UNKNOWN is used whenever the
   * increment cannot be attributed honestly (unchanged price, first
   * observation baseline, volume reset, or a polling gap too long to trust).
   */
  side: "BUY" | "SELL" | "UNKNOWN";
}

/** Honest accounting of how much volume could actually be attributed. */
export interface FlowAttribution {
  observations: number;
  attributedVol: number; // volume classified BUY or SELL
  unknownVol: number; // volume observed but not attributable
  totalVol: number;
  coveragePct: number; // attributedVol / totalVol * 100
  baselineVol: number | null; // first cumulative volume seen (never counted as traded)
  baselineAt: number | null;
  resets: number; // cumulative-volume resets / session rollovers detected
  gapsSkipped: number; // increments dropped because the polling gap was too long
  lastObsAt: number | null;
  partialSession: boolean; // tracker started after 09:16 IST
  /** Increments resolved by the bid/ask quote rule (preferred method). */
  quoteRuleCount: number;
  /** Increments resolved by the tick-rule fallback (mid-spread / no quote). */
  tickRuleCount: number;
}

export interface FlowBar {
  t: number; // bar open epoch (IST-aligned)
  buyVol: number;
  sellVol: number;
  /** Volume increments observed with no price movement to classify — conserved, never silently re-bucketed. */
  untracedVol: number;
  delta: number;
  cvd: number; // session-cumulative (reset 09:15 IST)
  perPrice: Record<string, { buy: number; sell: number }>;
}

// ------------------------------------------------------------------ signals

export type SignalScenario =
  | "BREAKOUT"
  | "BREAKOUT_RETEST"
  | "FAILED_BREAK"
  | "REVERSAL_REJECTION"
  | "TREND_PULLBACK";

export interface Signal {
  id: string;
  instrumentKey: string;
  timeframeMin: number;
  direction: "LONG" | "SHORT";
  scenario: SignalScenario;
  status: "WATCH" | "ACTIVE" | "INVALIDATED" | "EXPIRED";
  /** Rule-defined decision-support category — NEVER a win probability. */
  grade: "GOOD_TRADE" | "POSSIBLE_TRADE";
  entry: number | null; // trigger price for WATCH; fill proxy for ACTIVE
  stop: number | null; // invalidation
  targets: number[];
  rr: number | null; // reward:risk to first target
  score: number; // confluence score — NOT calibrated win probability
  breakdown: { k: string; v: number }[];
  confirmations: string[];
  pending: string[]; // confirmation events still required
  invalidationRule: string;
  trace: { rules: string[]; inputs: Record<string, number | string | null> };
  capabilityTags: string[]; // e.g. ['DELTA:ESTIMATED']
  dataQuality: DataQuality;
  createdAt: number;
  updatedAt: number;
  validUntil: number;
}

// ------------------------------------------------------------------- charts

export interface ChartAnalysis {
  instrumentKey: string;
  timeframeMin: number;
  quality: DataQuality;
  candles: Candle[];
  indicators: {
    ema9: (number | null)[];
    ema21: (number | null)[];
    ema50: (number | null)[];
    vwap: (number | null)[];
    rsi14: (number | null)[];
    atr14: (number | null)[];
  };
  structure: StructureEvent[];
  range: RangeInfo | null;
  zones: Zone[];
  profile: {
    mode: CalcMode;
    poc: number | null;
    vah: number | null;
    val: number | null;
    hvn: number[];
    lvn: number[];
  } | null;
  flow: {
    mode: CalcMode;
    reset: string;
    bars: FlowBar[];
  } | null;
  notes: string[];
}
