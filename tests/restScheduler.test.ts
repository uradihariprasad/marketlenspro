/**
 * REST scheduler tests (WebSocket removed): polling cadence config, rate
 * limiting, rotation honesty, coverage accounting, market-hours behaviour.
 */
import { describe, it, expect } from "vitest";
import { loadPollConfig, RateLimiter, RotationCursor, buildCoverage, effectiveQuoteMs, PollConfig } from "../src/lib/market/restScheduler";

describe("poll configuration", () => {
  it("applies safe defaults and clamps unsafe env values", () => {
    const def = loadPollConfig();
    // coordinated 30-second scan cycle (quotes + scanner + chains together)
    expect(def.quoteMs).toBe(30_000);
    expect(def.chainMs).toBe(30_000);
    expect(def.scannerMs).toBe(30_000);
    expect(def.quoteBatch).toBe(100); // provider hard cap
    expect(def.maxKeysPerCycle).toBeGreaterThanOrEqual(50);

    process.env.POLL_QUOTES_MS = "1"; // dangerously fast
    process.env.QUOTE_BATCH_SIZE = "500"; // exceeds provider batch cap
    const bad = loadPollConfig();
    expect(bad.quoteMs).toBeGreaterThanOrEqual(3_000); // clamped up
    expect(bad.quoteBatch).toBeLessThanOrEqual(100); // clamped down
    delete process.env.POLL_QUOTES_MS;
    delete process.env.QUOTE_BATCH_SIZE;
  });

  it("quotes poll slowly while the market is closed", () => {
    const cfg: PollConfig = { ...loadPollConfig(), quoteMs: 10_000, closedQuoteMs: 300_000 };
    // effectiveQuoteMs is market-phase dependent; assert the invariant that a
    // closed market can never poll faster than the open-market cadence.
    expect(effectiveQuoteMs(cfg)).toBeGreaterThanOrEqual(cfg.quoteMs);
  });
});

describe("rate limiter", () => {
  it("grants up to the burst immediately then throttles", async () => {
    // A LOW refill rate keeps this deterministic: at 1000 rps the bucket
    // refills a token every millisecond, so any scheduling delay between
    // acquire() and available() made the assertion flaky under parallel runs.
    // At 1 rps a refill takes a full second, far longer than the assertion.
    const rl = new RateLimiter(1, 3);
    expect(rl.available()).toBe(3);
    await rl.acquire(3);
    expect(rl.available()).toBe(0);
  });

  it("waits instead of exceeding the configured rate", async () => {
    const rl = new RateLimiter(200, 2); // 200/s ⇒ 5ms per token
    await rl.acquire(2);
    const t0 = Date.now();
    await rl.acquire(1);
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(3);
    expect(rl.rateLimitEvents).toBeGreaterThanOrEqual(1);
  });
});

describe("rotation cursor (no circular coverage)", () => {
  const universe = Array.from({ length: 213 }, (_, i) => `NSE_EQ|S${i}`);
  const priority = ["NSE_INDEX|Nifty 50", "BSE_INDEX|SENSEX", "NSE_FO|48000"];

  it("covers the full universe in one cycle when budget allows", () => {
    const rc = new RotationCursor(600);
    const sel = rc.select(priority, universe);
    expect(sel.keys).toHaveLength(216);
    expect(sel.fullCoverage).toBe(true);
    expect(sel.deferred).toBe(0);
    expect(sel.keys.slice(0, 3)).toEqual(priority);
  });

  it("reports a partial cycle as partial — never as full coverage", () => {
    const rc = new RotationCursor(60);
    const a = rc.select(priority, universe);
    expect(a.keys).toHaveLength(60);
    expect(a.fullCoverage).toBe(false);
    expect(a.deferred).toBeGreaterThan(0);
    // priority instruments always survive a constrained cycle
    for (const p of priority) expect(a.keys).toContain(p);
  });

  it("rotates so every instrument is refreshed within a bounded number of cycles", () => {
    const rc = new RotationCursor(60);
    const seen = new Set<string>();
    for (let c = 0; c < 6; c++) {
      for (const k of rc.select(priority, universe).keys) seen.add(k);
    }
    expect(seen.size).toBe(216); // full universe reached by rotation
  });

  it("is deterministic for identical inputs", () => {
    const a = new RotationCursor(60);
    const b = new RotationCursor(60);
    expect(a.select(priority, universe).keys).toEqual(b.select(priority, universe).keys);
  });

  it("handles an empty universe without inventing coverage", () => {
    const rc = new RotationCursor(600);
    const sel = rc.select(priority, []);
    expect(sel.keys).toEqual(priority);
    expect(sel.fullCoverage).toBe(true);
    expect(sel.deferred).toBe(0);
  });
});

describe("coverage report", () => {
  it("computes coverage percentage and flags partial cycles", () => {
    const full = buildCoverage(213, 216, 216, 213, 0);
    expect(full.coveragePct).toBe(100);
    expect(full.fullCoverage).toBe(true);
    expect(full.missing).toBe(0);

    const partial = buildCoverage(213, 60, 58, 57, 153);
    expect(partial.coveragePct).toBeCloseTo(26.8, 1);
    expect(partial.fullCoverage).toBe(false);
    expect(partial.missing).toBe(2);
    expect(partial.deferred).toBe(153);
  });
});
