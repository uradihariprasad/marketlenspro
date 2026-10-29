/**
 * Centralized REST market-data scheduler (WebSocket removed).
 *
 * Everything the application knows about market data now arrives through
 * Upstox REST endpoints polled by this module:
 *   - GET /v2/user/profile                     (token validation)
 *   - GET /v2/market-quote/quotes?symbol=A,B,C (batched quotes, <=100 keys)
 *   - GET /v2/historical-candle/{key}/{iv}/{to}/{from}   (multi-session)
 *   - GET /v2/historical-candle/{key}/{iv}/{to}          (current session)
 *   - GET /v2/option/contract, GET /v2/option/chain
 *   - Public instrument master (assets.upstox.com)
 *
 * Responsibilities:
 *  - env-driven, validated polling intervals per endpoint class
 *  - token-bucket rate limiting (never exceed the provider request budget)
 *  - deterministic rotation when a cycle's key count exceeds the request budget
 *  - coverage accounting so a partial cycle is never reported as complete
 *  - market-hours awareness: polling slows when the market is closed
 *
 * No WebSocket connection is opened anywhere for market data.
 */

import { marketPhase } from "./types";

// ------------------------------------------------------------------- config

export interface PollConfig {
  /** quotes (indices + futures + F&O equities) */
  quoteMs: number;
  /** scanner recomputation */
  scannerMs: number;
  /** option-chain snapshots */
  chainMs: number;
  /** historical candle backfill check */
  backfillMs: number;
  /** quote cadence while the market is closed (slow, keeps EOD fresh) */
  closedQuoteMs: number;
  /** provider request budget: sustained requests per second */
  rateRps: number;
  /** burst allowance on top of the sustained rate */
  rateBurst: number;
  /** max instruments requested per polling cycle (batching applied on top) */
  maxKeysPerCycle: number;
  /** provider quote batch size */
  quoteBatch: number;
}

function envInt(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Intervals are env-configurable and clamped to safe ranges so a bad env value
 * cannot drive the provider into throttling.
 *
 * DEFAULT SCAN CYCLE = 30s for quotes, scanner and option chains, so every
 * engine refreshes on ONE coordinated cadence instead of three competing
 * ones. Budget: ~435 keys ⇒ 5 quote batches + ~3 chain requests per cycle
 * ≈ 8 requests / 30s ≈ 0.27 req/s — comfortably inside provider limits.
 *
 * IMPORTANT: a 30s cycle is NOT a new 5m/15m observation window. It refreshes
 * current data; the rolling OI windows are always computed from timestamped
 * historical observations (see oiIntelligence.OiHistory).
 */
export function loadPollConfig(): PollConfig {
  return {
    quoteMs: envInt("POLL_QUOTES_MS", 30_000, 3_000, 120_000),
    scannerMs: envInt("POLL_SCANNER_MS", 30_000, 5_000, 120_000),
    chainMs: envInt("POLL_CHAIN_MS", 30_000, 10_000, 300_000),
    backfillMs: envInt("POLL_BACKFILL_MS", 300_000, 60_000, 3_600_000),
    closedQuoteMs: envInt("POLL_CLOSED_QUOTES_MS", 300_000, 60_000, 3_600_000),
    rateRps: envInt("RATE_LIMIT_RPS", 25, 1, 50),
    rateBurst: envInt("RATE_LIMIT_BURST", 25, 1, 100),
    maxKeysPerCycle: envInt("POLL_MAX_KEYS_PER_CYCLE", 600, 50, 5_000),
    quoteBatch: envInt("QUOTE_BATCH_SIZE", 100, 1, 100), // provider hard cap
  };
}

// --------------------------------------------------------------- rate limit

/**
 * Continuous token bucket. `acquire()` resolves only when budget exists, so a
 * polling burst is physically unable to exceed the configured rate.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  rateLimitEvents = 0;
  totalWaitedMs = 0;

  constructor(
    private readonly rps: number,
    private readonly burst: number
  ) {
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.rps);
    this.lastRefill = now;
  }

  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  async acquire(n = 1): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      const deficit = n - this.tokens;
      const waitMs = Math.ceil((deficit / this.rps) * 1000) + 5;
      this.rateLimitEvents++;
      this.totalWaitedMs += waitMs;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

// ---------------------------------------------------------------- rotation

/**
 * Deterministic rotating cursor. When the desired universe exceeds the
 * per-cycle request budget, instruments are served in stable priority order
 * (priority list first, then rotating bands) so every instrument is refreshed
 * within a bounded number of cycles. A partial cycle is reported as partial —
 * never as full coverage.
 */
export class RotationCursor {
  private cursor = 0;

  constructor(private readonly maxKeysPerCycle: number) {}

  /**
   * @param priority always included when budget allows (indices, futures, focus)
   * @param rest the remainder of the universe, rotated
   * @returns the keys to poll this cycle plus honest coverage metadata
   */
  select(priority: readonly string[], rest: readonly string[]): {
    keys: string[];
    priorityCount: number;
    rotatedCount: number;
    deferred: number;
    fullCoverage: boolean;
  } {
    const budget = Math.max(this.maxKeysPerCycle, priority.length);
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const k of priority) {
      if (seen.has(k)) continue;
      seen.add(k);
      keys.push(k);
    }
    const priorityCount = keys.length;
    if (rest.length === 0 || keys.length >= budget) {
      return { keys, priorityCount, rotatedCount: 0, deferred: Math.max(0, rest.length), fullCoverage: rest.length === 0 };
    }
    const remaining = budget - keys.length;
    if (remaining >= rest.length) {
      for (const k of rest) if (!seen.has(k)) { seen.add(k); keys.push(k); }
      this.cursor = 0;
      return { keys, priorityCount, rotatedCount: rest.length, deferred: 0, fullCoverage: true };
    }
    // rotate a window through `rest`
    const ordered = [...rest];
    const start = this.cursor % Math.max(ordered.length, 1);
    let picked = 0;
    for (let i = 0; i < ordered.length && picked < remaining; i++) {
      const k = ordered[(start + i) % ordered.length];
      if (seen.has(k)) continue;
      seen.add(k);
      keys.push(k);
      picked++;
    }
    this.cursor = (start + picked) % Math.max(ordered.length, 1);
    return { keys, priorityCount, rotatedCount: picked, deferred: ordered.length - picked, fullCoverage: false };
  }

  reset(): void {
    this.cursor = 0;
  }
}

// ------------------------------------------------------------ cycle records

export interface PollCycleRecord {
  t: number;
  endpoint: string;
  ok: boolean;
  requested: number;
  returned: number;
  validLtp: number;
  http: number | null;
  ms: number;
  note: string;
}

export interface CoverageReport {
  eligible: number;
  requested: number;
  returned: number;
  validLtp: number;
  missing: number;
  deferred: number;
  fullCoverage: boolean;
  coveragePct: number;
}

export function buildCoverage(eligible: number, requested: number, returned: number, validLtp: number, deferred: number): CoverageReport {
  const missing = Math.max(0, requested - returned);
  const coveragePct = eligible > 0 ? Math.round((validLtp / eligible) * 1000) / 10 : 0;
  return {
    eligible,
    requested,
    returned,
    validLtp,
    missing,
    deferred,
    fullCoverage: deferred === 0 && missing === 0,
    coveragePct,
  };
}

/** Effective quote cadence right now (market-hours aware). */
export function effectiveQuoteMs(cfg: PollConfig): number {
  return marketPhase() === "OPEN" ? cfg.quoteMs : cfg.closedQuoteMs;
}
