/**
 * Upstox broker adapter — primary market data provider.
 *
 * AUTH LIFECYCLE (documented per broker-adapter contract):
 *  - The user supplies a daily Upstox API access token on the login screen.
 *    Token is generated via the Upstox OAuth flow (api.upstox.com) and
 *    typically expires at 03:30 IST the following day.
 *  - The token is validated immediately against GET /v2/user/profile.
 *  - The token is stored SERVER-SIDE only (PostgreSQL `settings` table +
 *    in-memory engine). It is never sent back to the browser, never logged,
 *    and never embedded in error messages.
 *  - A 401 response marks status TOKEN_EXPIRED and prompts re-login.
 *
 * CAPABILITY NOTES:
 *  - Historical candles: GET /v2/historical-candle/{key}/{interval}/{to}/{from}
 *    (public endpoint; intervals: 1minute, 30minute, day, week, month).
 *  - Quotes: GET /v2/market-quote/quotes?symbol=... (auth, <=100 keys/req).
 *  - Option chain: GET /v2/option/chain (auth) + /v2/option/contract.
 *  - Instrument master: public gzipped JSON at assets.upstox.com.
 *  - Rate limits respected via a serialized request queue (~25 req/s max).
 *  - No aggressor-side trade classification is available on REST surfaces.
 *  - The protobuf WebSocket feed is out of scope for this REST-polling
 *    deployment; the capability matrix discloses the estimation limits
 *    that follow from polling.
 */

import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import {
  Candle,
  InstrumentMeta,
  Quote,
  istDateKey,
} from "./types";

const gunzipAsync = promisify(gunzip);
const API = "https://api.upstox.com/v2";
const ASSETS = "https://assets.upstox.com/market-quote/instruments/exchange";
const UA = "fno-intel/1.0 (+rest-poll)";

export class UpstoxError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "UpstoxError";
    this.status = status;
  }
}

// ---------------------------------------------------------------- low-level

let queue: Promise<unknown> = Promise.resolve();
function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn);
  queue = p.catch(() => undefined).then(() => new Promise((r) => setTimeout(r, 45)));
  return p;
}

async function httpJson<T>(
  url: string,
  token: string | null,
  timeoutMs = 15000
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": UA };
  if (token) headers.Authorization = `Bearer ${token}`; // header never logged/escaped
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new UpstoxError(`network error contacting Upstox (${(e as Error).name})`, 0);
  }
  if (res.status === 401) throw new UpstoxError("Upstox rejected the access token (401)", 401);
  if (res.status === 429) throw new UpstoxError("Upstox rate limit reached (429)", 429);
  if (!res.ok) throw new UpstoxError(`Upstox HTTP ${res.status}`, res.status);
  const body = (await res.json()) as { status?: string; data?: T } & T;
  return ("data" in body && body.data !== undefined ? body.data : body) as T;
}

// -------------------------------------------------------------------- auth

export interface UpstoxProfile {
  userName: string;
  userId: string;
  exchanges: string[];
}

export async function validateToken(token: string): Promise<UpstoxProfile> {
  const d = await httpJson<Record<string, unknown>>(`${API}/user/profile`, token, 12000);
  return {
    userName: String(d.user_name ?? "Upstox User"),
    userId: String(d.user_id ?? ""),
    exchanges: Array.isArray(d.exchanges) ? (d.exchanges as string[]) : [],
  };
}

// ---------------------------------------------------------- instrument master

export interface RawInstrument {
  segment?: string;
  name?: string;
  exchange?: string;
  isin?: string;
  instrument_type?: string;
  instrument_key?: string;
  lot_size?: number;
  freeze_quantity?: number;
  exchange_token?: string;
  tick_size?: number;
  trading_symbol?: string;
  qty_multiplier?: number;
  security_type?: string;
  expiry?: number | string;
  strike?: number | string;
  option_type?: string;
  weekly?: boolean;
  underlying_symbol?: string;
  underlying_key?: string;
  asset_symbol?: string;
  asm_or_gsm?: string;
  annual_return?: number;
}

/**
 * Option-chain capability resolved FROM THE INSTRUMENT MASTER.
 * Every CE/PE contract carries `underlying_key` (e.g. NSE_EQ|INE002A01018),
 * so we know exactly which underlyings have listed options and which expiries
 * exist — without spending a single API call on unsupported instruments.
 */
export interface OptionUnderlying {
  underlyingKey: string;
  symbol: string;
  /** Ascending IST YYYY-MM-DD expiries that are today or later. */
  expiries: string[];
  contractCount: number;
  isIndex: boolean;
}

export interface Universe {
  loadedAt: number;
  indices: Record<"NIFTY" | "BANKNIFTY" | "SENSEX", InstrumentMeta | null>;
  /** underlying instrument key -> option capability (from the master file). */
  optionUnderlyings: Map<string, OptionUnderlying>;
  /** Current- and next-expiry futures keyed by display name (NIFTY, RELIANCE, ...). */
  futures: Map<string, InstrumentMeta[]>;
  /** F&O-eligible equity instruments (derived from current FUTSTK contracts, never a hardcoded list). */
  foEquities: InstrumentMeta[];
  /** futures instrument_key -> equity instrument_key */
  futToEq: Map<string, string>;
  countRaw: number;
}

function toMeta(r: RawInstrument): InstrumentMeta {
  // Upstox master files express tick_size in PAISE (5.0 = ₹0.05) for most
  // records — normalized to rupees; records already in rupees pass through.
  const rawTick = typeof r.tick_size === "number" && r.tick_size > 0 ? r.tick_size : 5;
  const tick = rawTick >= 0.5 ? rawTick / 100 : rawTick;
  return {
    instrumentKey: String(r.instrument_key ?? ""),
    tradingSymbol: String(r.trading_symbol ?? ""),
    name: String(r.name ?? r.trading_symbol ?? ""),
    segment: String(r.segment ?? ""),
    instrumentType: String(r.instrument_type ?? ""),
    underlyingKey: r.underlying_key ? String(r.underlying_key) : undefined,
    underlyingSymbol: r.underlying_symbol ? String(r.underlying_symbol) : r.asset_symbol ? String(r.asset_symbol) : undefined,
    expiry: typeof r.expiry === "number" ? r.expiry : undefined,
    strike: r.strike !== undefined ? Number(r.strike) : undefined,
    optionType: r.option_type === "CE" || r.option_type === "PE" ? r.option_type : undefined,
    lotSize: typeof r.lot_size === "number" ? r.lot_size : undefined,
    tickSize: tick,
    weekly: r.weekly === true,
  };
}

/** Index futures are keyed by index NAME in the master (no dedicated type). */
const INDEX_NAMES = new Set(["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "BANKEX"]);

/** Canonical spot-index meta for keys verified against the candle API. */
function idxMeta(instrumentKey: string, label: string): InstrumentMeta {
  return {
    instrumentKey,
    tradingSymbol: label,
    name: label,
    segment: instrumentKey.split("|")[0],
    instrumentType: "INDEX",
    tickSize: 0.05,
  };
}

async function downloadSegment(file: string): Promise<RawInstrument[]> {
  const res = await fetch(`${ASSETS}/${file}`, { signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new UpstoxError(`instrument master ${file} HTTP ${res.status}`, res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const json = await gunzipAsync(buf);
  return JSON.parse(json.toString("utf8")) as RawInstrument[];
}

/**
 * Download and filter the official Upstox instrument master. The eligible
 * F&O stock universe is derived from CURRENT FUTSTK contracts in the master
 * file — never from a stale hardcoded list (rule 9).
 */
export async function loadUniverse(): Promise<Universe> {
  const [nse, bse] = await Promise.all([
    downloadSegment("NSE.json.gz"),
    downloadSegment("BSE.json.gz"),
  ]);
  const raw = [...nse, ...bse];
  const todayKey = istDateKey(Date.now());

  const indices: Universe["indices"] = { NIFTY: null, BANKNIFTY: null, SENSEX: null };
  const eqBySymbol = new Map<string, InstrumentMeta>();
  const futGroups = new Map<string, InstrumentMeta[]>();
  const futToEq = new Map<string, string>();
  // underlying key -> { expiry set, symbol, count } built from CE/PE contracts
  const optAgg = new Map<string, { symbol: string; expiries: Set<string>; count: number; isIndex: boolean }>();

  for (const r of raw) {
    const seg = String(r.segment ?? "");
    const type = String(r.instrument_type ?? "");
    const sym = String(r.trading_symbol ?? "");
    if (!r.instrument_key) continue;

    if (seg === "NSE_INDEX") {
      // master uses name in instrument_key; trading_symbol is uppercase
      if (/^nifty 50$/i.test(sym) && !indices.NIFTY) indices.NIFTY = toMeta(r);
      if (/^(nifty bank|banknifty)$/i.test(sym.replace(/\s+/g, " ")) && !indices.BANKNIFTY) indices.BANKNIFTY = toMeta(r);
      if (/^banknifty$/i.test(sym) && !indices.BANKNIFTY) indices.BANKNIFTY = toMeta(r);
      continue;
    }
    if (seg === "BSE_INDEX") {
      if (/^sensex$/i.test(sym) && !indices.SENSEX) indices.SENSEX = toMeta(r);
      continue;
    }
    if (seg === "NSE_EQ" && (type === "EQ" || type === "BE")) {
      if (sym && !eqBySymbol.has(sym)) eqBySymbol.set(sym, toMeta(r));
      continue;
    }
    // Option contracts: resolve chain capability + expiries per underlying
    if ((seg === "NSE_FO" || seg === "BSE_FO") && (type === "CE" || type === "PE")) {
      const uk = r.underlying_key ? String(r.underlying_key) : "";
      if (!uk || typeof r.expiry !== "number") continue;
      const expKey = istDateKey(r.expiry);
      if (expKey < todayKey) continue; // expired contract — never offered
      const sym = String(r.underlying_symbol ?? r.asset_symbol ?? "").toUpperCase();
      const cur = optAgg.get(uk) ?? { symbol: sym, expiries: new Set<string>(), count: 0, isIndex: uk.includes("_INDEX") };
      cur.expiries.add(expKey);
      cur.count++;
      if (!cur.symbol && sym) cur.symbol = sym;
      optAgg.set(uk, cur);
      continue;
    }
    if ((seg === "NSE_FO" || seg === "BSE_FO") && type === "FUT") {
      const m = toMeta(r);
      const nameU = m.name.toUpperCase().trim();
      const undU = (m.underlyingSymbol ?? "").toUpperCase().trim();
      // index futures are keyed by index NAME; stock futures by underlying_symbol
      const display = INDEX_NAMES.has(nameU) ? nameU : undU || nameU;
      if (!display) continue;
      const arr = futGroups.get(display) ?? [];
      arr.push(m);
      futGroups.set(display, arr);
    }
  }

  // Fallbacks: canonical spot-index instrument keys verified against the
  // historical-candle API (the public master omits some broad indices).
  if (!indices.NIFTY) indices.NIFTY = idxMeta("NSE_INDEX|Nifty 50", "NIFTY 50");
  if (!indices.BANKNIFTY) indices.BANKNIFTY = idxMeta("NSE_INDEX|Nifty Bank", "NIFTY BANK");
  if (!indices.SENSEX) indices.SENSEX = idxMeta("BSE_INDEX|SENSEX", "SENSEX");

  // keep only current + next expiry per underlying, sorted
  for (const [k, arr] of futGroups) {
    arr.sort((a, b) => (a.expiry ?? 0) - (b.expiry ?? 0));
    const live = arr.filter((f) => f.expiry && istDateKey(f.expiry) >= todayKey);
    futGroups.set(k, live.slice(0, 2));
  }

  const foEquities: InstrumentMeta[] = [];
  for (const [k, futs] of futGroups) {
    if (futs.length === 0) continue;
    if (["NIFTY", "BANKNIFTY", "SENSEX"].includes(k)) continue;
    const eq = eqBySymbol.get(k) ?? null;
    if (eq) {
      foEquities.push(eq);
      for (const f of futs) futToEq.set(f.instrumentKey, eq.instrumentKey);
    }
  }
  foEquities.sort((a, b) => a.tradingSymbol.localeCompare(b.tradingSymbol));

  const optionUnderlyings = new Map<string, OptionUnderlying>();
  for (const [uk, agg] of optAgg) {
    optionUnderlyings.set(uk, {
      underlyingKey: uk,
      symbol: agg.symbol || uk,
      expiries: [...agg.expiries].sort(),
      contractCount: agg.count,
      isIndex: agg.isIndex,
    });
  }

  return { loadedAt: Date.now(), indices, optionUnderlyings, futures: futGroups, foEquities, futToEq, countRaw: raw.length };
}

// ------------------------------------------------------------- historical OHLCV

export type HistInterval = "1minute" | "30minute" | "day" | "week" | "month";

/**
 * Candles return provider timestamps with IST offset; volume is per-bar (not
 * cumulative) per Upstox docs; index instruments report volume 0. Returned
 * ascending by time, deduped.
 */
export async function fetchHistoricalCandles(
  instrumentKey: string,
  interval: HistInterval,
  toDate: string,
  fromDate: string,
  token: string | null
): Promise<Candle[]> {
  const key = encodeURIComponent(instrumentKey);
  const url = `${API}/historical-candle/${key}/${interval}/${toDate}/${fromDate}`;
  type Raw = { candles?: [string, number, number, number, number, number, number][] };
  const d = await schedule(() => httpJson<Raw>(url, token, 20000));
  const rows = d.candles ?? [];
  const out: Candle[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    const t = new Date(r[0]).getTime();
    if (!Number.isFinite(t) || seen.has(t)) continue;
    seen.add(t);
    out.push({ t, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] ?? 0, oi: r[6] ?? undefined, closed: true });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Current-session (intraday) candles.
 *
 * Documented path: GET /v2/historical-candle/intraday/{instrument_key}/{interval}
 * (no date parameters — it always means "today"). The date-based historical
 * endpoint (/v2/historical-candle/{key}/{interval}/{to}/{from}) is used by
 * fetchHistoricalCandles instead, so the two are never mixed up.
 *
 * If the documented intraday path is unavailable for an instrument, we fall
 * back to a single-date historical request for today and report it, rather
 * than returning an empty array.
 */
export async function fetchIntradayCandles(
  instrumentKey: string,
  interval: HistInterval,
  toDate: string,
  token: string | null
): Promise<Candle[]> {
  const key = encodeURIComponent(instrumentKey);
  type Raw = { candles?: [string, number, number, number, number, number, number][] };
  const toCandles = (d: Raw): Candle[] =>
    (d.candles ?? [])
      .map((r) => ({ t: new Date(r[0]).getTime(), o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] ?? 0, oi: r[6] ?? undefined, closed: true }))
      .sort((a, b) => a.t - b.t);

  try {
    const d = await schedule(() => httpJson<Raw>(`${API}/historical-candle/intraday/${key}/${interval}`, token, 20000));
    return toCandles(d);
  } catch (e) {
    // Fallback: single-date historical form (documented) for the same session
    const d = await schedule(() => httpJson<Raw>(`${API}/historical-candle/${key}/${interval}/${toDate}/${toDate}`, token, 20000));
    void e;
    return toCandles(d);
  }
}

// ------------------------------------------------------------------- quotes

interface RawDepthLevel { quantity?: number; price?: number; orders?: number }
interface RawQuote {
  instrument_token?: string;
  timestamp?: string;
  last_trade_time?: string;
  last_price?: number;
  last_quantity?: number;
  volume?: number;
  average_price?: number;
  oi?: number;
  net_change?: number;
  ohlc?: { open?: number; high?: number; low?: number; close?: number };
  depth?: { buy?: RawDepthLevel[]; sell?: RawDepthLevel[] };
  total_buy_quantity?: number;
  total_sell_quantity?: number;
}

/**
 * Fetch full market quotes via REST.
 *
 * VERIFIED against the documented response example
 * (https://upstox.com/developer/api-documentation/get-full-market-quote):
 *  - the response `data` map is keyed as `NSE_EQ:NHPC` (segment:SYMBOL), which
 *    does NOT match the `NSE_EQ|INE848E01016` key we requested. The canonical
 *    pipe-format key is returned in the `instrument_token` FIELD of each
 *    entry. We therefore map responses back through `instrument_token` and
 *    only accept instruments we actually requested — otherwise every cache
 *    lookup by instrument key would silently miss (the live-data bug).
 *  - `last_trade_time` is an epoch-millis STRING ("1697624972130"), which
 *    Date parsing cannot interpret; it must be parsed numerically.
 *  - `oi` is a genuine numeric 0 for equities, which is distinct from missing.
 *  - Both `symbol` and `instrument_key` query spellings are sent defensively
 *    so the request is valid regardless of which the current API rev expects.
 */
export async function fetchQuotes(instrumentKeys: string[], token: string): Promise<Quote[]> {
  const out: Quote[] = [];
  const requested = new Set(instrumentKeys);
  const chunks: string[][] = [];
  for (let i = 0; i < instrumentKeys.length; i += 100) chunks.push(instrumentKeys.slice(i, i + 100));
  for (const chunk of chunks) {
    const q = chunk.map(encodeURIComponent).join(",");
    const data = await schedule(() =>
      httpJson<Record<string, RawQuote>>(
        `${API}/market-quote/quotes?symbol=${q}&instrument_key=${q}`,
        token,
        15000
      )
    );
    if (!data || typeof data !== "object") {
      throw new UpstoxError("quote response had no data object (EMPTY_RESPONSE)", 200);
    }
    const now = Date.now();
    for (const [rawKey, rq] of Object.entries(data)) {
      // Resolve the canonical pipe-format key: instrument_token first, then
      // an exact/raw match against the requested keys.
      const canonical =
        typeof rq.instrument_token === "string" && requested.has(rq.instrument_token)
          ? rq.instrument_token
          : requested.has(rawKey)
            ? rawKey
            : null;
      if (!canonical) continue; // never inject an instrument we did not request
      if (rq.last_price === undefined || rq.last_price === null || !Number.isFinite(rq.last_price)) {
        continue; // an entry without a valid LTP is not a quote — count as missing
      }
      const depthBuy = rq.depth?.buy?.find((d) => (d?.price ?? 0) > 0);
      const depthSell = rq.depth?.sell?.find((d) => (d?.price ?? 0) > 0);
      const depthLevels = ((rq.depth?.buy?.length ?? 0) >= 5 && (rq.depth?.sell?.length ?? 0) >= 5) ? 5
        : (depthBuy || depthSell) ? 1 : 0;
      out.push({
        instrumentKey: canonical,
        source: "UPSTOX_REST_POLL",
        exchangeTs: parseProviderTs(rq.timestamp),
        lastTradeTs: parseProviderTs(rq.last_trade_time),
        localTs: now,
        ltp: num(rq.last_price),
        netChange: num(rq.net_change),
        ltq: num(rq.last_quantity),
        volumeCum: num(rq.volume),
        oi: num(rq.oi),
        open: num(rq.ohlc?.open),
        high: num(rq.ohlc?.high),
        low: num(rq.ohlc?.low),
        close: num(rq.ohlc?.close),
        atp: num(rq.average_price),
        bid: depthBuy?.price !== undefined ? { p: depthBuy.price, q: depthBuy.quantity ?? 0 } : null,
        ask: depthSell?.price !== undefined ? { p: depthSell.price, q: depthSell.quantity ?? 0 } : null,
        bids: depthList(rq.depth?.buy),
        asks: depthList(rq.depth?.sell),
        depthLevels: depthLevels as 0 | 1 | 5,
        quality: "LIVE",
      });
    }
  }
  return out;
}

/** Keep only populated depth levels; the provider zero-fills empty slots. */
function depthList(levels: RawDepthLevel[] | undefined): { p: number; q: number }[] {
  return (levels ?? [])
    .filter((d) => typeof d?.price === "number" && d.price > 0)
    .map((d) => ({ p: d.price as number, q: d.quantity ?? 0 }));
}

/**
 * Parse provider timestamps. `timestamp` is ISO-8601 with offset
 * ("2023-10-19T05:21:51.099+05:30") while `last_trade_time` is an
 * epoch-millis STRING ("1697624972130") — each needs different handling.
 */
export function parseProviderTs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    if (/^\d{10,}$/.test(v.trim())) {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// -------------------------------------------------------------- option chain

export interface RawChainSide {
  instrument_key?: string;
  market_data?: {
    ltp?: number; volume?: number; oi?: number; prev_oi?: number;
    bid_price?: number; bid_qty?: number; ask_price?: number; ask_qty?: number;
    close_price?: number; atp?: number;
  };
  option_greeks?: { vega?: number; theta?: number; gamma?: number; delta?: number; iv?: number; pop?: number };
}

export interface RawChainStrike {
  expiry?: string;
  strike_price: number;
  underlying_key?: string;
  underlying_spot_price?: number;
  pcr?: number;
  call_options?: RawChainSide;
  put_options?: RawChainSide;
}

export interface OptionContractInfo {
  expiries: string[]; // YYYY-MM-DD ascending
}

export async function fetchOptionContracts(instrumentKey: string, token: string): Promise<OptionContractInfo> {
  const d = await schedule(() =>
    httpJson<RawInstrument[]>(`${API}/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`, token, 20000)
  );
  const set = new Set<string>();
  for (const c of d ?? []) {
    if (typeof c.expiry === "number") {
      set.add(istDateKey(c.expiry));
    } else if (typeof c.expiry === "string" && /^\d{4}-\d{2}-\d{2}/.test(c.expiry)) {
      set.add(c.expiry.slice(0, 10));
    }
  }
  const expiries = [...set].sort();
  return { expiries };
}

/** Nearest expiry >= today (includes 0DTE). */
export function pickNearestExpiry(expiries: string[], now = Date.now()): string | null {
  const today = istDateKey(now);
  for (const e of expiries) if (e >= today) return e;
  return expiries[expiries.length - 1] ?? null;
}

export async function fetchOptionChain(
  instrumentKey: string,
  expiryDate: string,
  token: string
): Promise<RawChainStrike[]> {
  const d = await schedule(() =>
    httpJson<RawChainStrike[]>(
      `${API}/option/chain?instrument_key=${encodeURIComponent(instrumentKey)}&expiry_date=${expiryDate}`,
      token,
      25000
    )
  );
  return Array.isArray(d) ? d : [];
}

export { UpstoxError as BrokerError };
