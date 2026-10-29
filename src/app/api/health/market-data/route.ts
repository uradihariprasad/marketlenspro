/**
 * Market-data diagnostic endpoint (safe: no tokens, no auth headers).
 *
 * Reports the real state of the REST market-data pipeline with an explicit
 * status taxonomy. HEALTHY is only reported when a live quote actually
 * answered for a requested instrument — never merely because the server
 * process is running.
 *
 * Statuses:
 *   NOT_CONFIGURED    no Upstox token has ever been supplied
 *   AUTH_FAILED       token present but rejected (401) or invalid
 *   POLLING_NOT_RUNNING engine booted but the poll loop has never completed
 *   MAPPING_ERROR     instrument master absent / no eligible instruments
 *   EMPTY_RESPONSE    poll succeeded but returned no usable quotes
 *   API_ERROR         provider/network error on the last attempt
 *   STALE_DATA        quotes exist but all older than the freshness window
 *   MARKET_CLOSED     market not open AND no fresh quotes (expected off-hours)
 *   HEALTHY           fresh, valid quotes present for requested instruments
 */
import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/market/engine";
import { marketPhase } from "@/lib/market/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FRESH_MS = 25_000;

export async function GET() {
  const e = await ensureBoot();
  const s = e.getStatus();
  const now = Date.now();

  const tokenStatus = s.tokenStatus;
  const universeLoaded = s.universe.loaded;
  const eligible = s.coverage?.eligibleStocks ?? 0;
  const fresh = s.coverage?.freshEquityQuotes ?? 0;
  const lastCycleReturned = s.coverage?.lastCycleReturned ?? 0;
  const lastAttempt = s.lastPollAt;
  const lastError = s.counters.lastError;
  const lastErrorAt = s.counters.lastErrorAt;
  const open = marketPhase(now) === "OPEN";

  // Error category from the last recorded engine error (sanitized text only)
  let errorCategory: string | null = null;
  if (lastError) {
    if (/401|rejected the access token|token/i.test(lastError)) errorCategory = "AUTH_FAILED";
    else if (/429|rate limit/i.test(lastError)) errorCategory = "RATE_LIMITED";
    else if (/timeout|abort/i.test(lastError)) errorCategory = "TIMEOUT";
    else if (/network|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(lastError)) errorCategory = "NETWORK";
    else if (/HTTP \d{5}/.test(lastError)) errorCategory = "PROVIDER_SERVER_ERROR";
    else errorCategory = "API_ERROR";
  }

  let status: string;
  const reasons: string[] = [];
  if (tokenStatus === "NONE") {
    status = "NOT_CONFIGURED";
    reasons.push("No Upstox access token has been supplied. Enter a token on the login screen to enable live data.");
  } else if (tokenStatus === "EXPIRED" || tokenStatus === "INVALID") {
    status = "AUTH_FAILED";
    reasons.push(`Token state is ${tokenStatus}. Generate a fresh Upstox token (they expire ~03:30 IST the day after creation).`);
  } else if (!universeLoaded) {
    status = "MAPPING_ERROR";
    reasons.push(s.universe.error ?? "Instrument master not loaded yet; retrying with backoff.");
  } else if (eligible === 0) {
    status = "MAPPING_ERROR";
    reasons.push("Instrument master loaded but no eligible F&O instruments resolved.");
  } else if (e.pollCycles === 0) {
    status = "POLLING_NOT_RUNNING";
    reasons.push("Engine authenticated and universe loaded, but no polling cycle has completed yet.");
  } else if (lastCycleReturned === 0) {
    status = "EMPTY_RESPONSE";
    reasons.push("Polling ran but the provider returned no usable quotes for the requested instruments.");
  } else if (fresh === 0 && open) {
    status = errorCategory ? "API_ERROR" : "STALE_DATA";
    reasons.push(
      errorCategory
        ? `Last error category ${errorCategory}: ${lastError}`
        : `All cached quotes are older than ${FRESH_MS / 1000}s while the market is open.`
    );
  } else if (fresh === 0 && !open) {
    status = "MARKET_CLOSED";
    reasons.push(`Market is ${s.marketPhase}; no fresh quotes expected. Polling slows to keep EOD data truthful.`);
  } else {
    status = "HEALTHY";
    reasons.push(`${fresh} instruments have fresh validated quotes (within ${FRESH_MS / 1000}s).`);
  }

  return NextResponse.json({
    status,
    reasons,
    marketDataMode: "REST_API_POLLING",
    auth: {
      tokenStatus,
      profile: s.profileName ?? null,
      // never the token itself
    },
    instrumentMaster: {
      loaded: universeLoaded,
      eligibleInstruments: eligible,
      rawInstruments: s.universe.rawCount,
      indices: s.universe.indices,
      error: s.universe.error,
    },
    polling: {
      cycles: e.pollCycles,
      failedCycles: e.pollCyclesFailed,
      running: e.pollCycles > 0,
      lastAttempt: lastAttempt,
      lastSuccessfulCycle: lastAttempt,
      quoteIntervalMs: s.transport?.quoteIntervalMs ?? null,
      scannerIntervalMs: s.transport?.scannerIntervalMs ?? null,
      chainIntervalMs: s.transport?.chainIntervalMs ?? null,
    },
    quotes: {
      lastSuccessfulFetch: lastAttempt,
      requestedLastCycle: s.coverage?.lastCycleRequested ?? 0,
      returnedLastCycle: lastCycleReturned,
      validLtpLastCycle: s.coverage?.lastCycleValidLtp ?? 0,
      missingLastCycle: s.coverage ? Math.max(0, (s.coverage.lastCycleRequested ?? 0) - lastCycleReturned) : 0,
      freshCount: fresh,
      staleCount: s.coverage?.staleEquityQuotes ?? 0,
      coveragePct: s.coverage?.coveragePct ?? 0,
      deferredToNextRotation: s.coverage?.deferredToNextRotation ?? 0,
      fullCoverage: s.coverage?.fullCoverage ?? false,
    },
    candles: {
      lastSuccessfulFetch: s.counters.candleFetches > 0 ? lastAttempt : null,
      fetchCount: s.counters.candleFetches,
    },
    optionChain: {
      lastSuccessfulFetch: s.lastChainAt,
      fetchCount: s.counters.chainFetches,
    },
    rateLimit: {
      configuredRps: s.transport?.rateRps ?? null,
      waitEvents: s.transport?.rateLimitWaits ?? 0,
      totalWaitedMs: s.transport?.rateLimitWaitedMs ?? 0,
    },
    lastError: {
      category: errorCategory,
      message: lastError, // sanitized by the engine (bearer values redacted)
      at: lastErrorAt || null,
      ageMs: lastErrorAt ? now - lastErrorAt : null,
    },
    marketPhase: s.marketPhase,
    istClock: s.istClock,
  });
}
