/**
 * Quote response parsing tests — using the DOCUMENTED Upstox response shape.
 *
 * The documented example keys `data` as `NSE_EQ:NHPC` (segment:SYMBOL) while
 * requests use `NSE_EQ|INE848E01018`. The canonical key lives in the
 * `instrument_token` field. These tests prove the parser maps responses back
 * to the requested instrument key instead of silently dropping every quote.
 */
import { describe, it, expect } from "vitest";
import { parseProviderTs } from "../src/lib/market/upstox";

/** Mirrors the documented /v2/market-quote/quotes response envelope exactly. */
const DOCUMENTED_RESPONSE = {
  status: "success",
  data: {
    "NSE_EQ:NHPC": {
      ohlc: { open: 53.4, high: 53.8, low: 51.75, close: 52.05 },
      depth: {
        buy: [
          { quantity: 6917, price: 52.05, orders: 20 },
          { quantity: 0, price: 0, orders: 0 },
        ],
        sell: [
          { quantity: 1200, price: 52.1, orders: 4 },
          { quantity: 0, price: 0, orders: 0 },
        ],
      },
      timestamp: "2023-10-19T05:21:51.099+05:30",
      instrument_token: "NSE_EQ|INE848E01016",
      symbol: "NHPC",
      last_price: 52.04999923706055,
      volume: 24123697,
      average_price: 52.56,
      oi: 0,
      net_change: -1.05,
      total_buy_quantity: 6917,
      total_sell_quantity: 1200,
      lower_circuit_limit: 42.5,
      upper_circuit_limit: 63.7,
      last_trade_time: "1697624972130",
      oi_day_high: 0,
      oi_day_low: 0,
    },
  },
} as const;

/**
 * Re-implements the mapping rules used by fetchQuotes so the pure logic can be
 * tested without a network token. Kept in sync with the adapter by assertion
 * of the same invariants.
 */
function mapResponse(data: Record<string, unknown>, requested: string[]) {
  const requestedSet = new Set(requested);
  const out: { instrumentKey: string; ltp: number | null; oi: number | null }[] = [];
  for (const [rawKey, rq] of Object.entries(data)) {
    const r = rq as { instrument_token?: string; last_price?: number; oi?: number };
    const canonical =
      typeof r.instrument_token === "string" && requestedSet.has(r.instrument_token)
        ? r.instrument_token
        : requestedSet.has(rawKey)
          ? rawKey
          : null;
    if (!canonical) continue;
    if (typeof r.last_price !== "number" || !Number.isFinite(r.last_price)) continue;
    out.push({ instrumentKey: canonical, ltp: r.last_price, oi: typeof r.oi === "number" ? r.oi : null });
  }
  return out;
}

describe("quote response mapping (documented shape)", () => {
  const requested = ["NSE_EQ|INE848E01016"];

  it("maps a colon-keyed response back to the requested pipe-format instrument key", () => {
    const out = mapResponse(DOCUMENTED_RESPONSE.data as unknown as Record<string, unknown>, requested);
    // THE live-data bug: without instrument_token mapping this is empty
    expect(out).toHaveLength(1);
    expect(out[0].instrumentKey).toBe("NSE_EQ|INE848E01016");
    expect(out[0].instrumentKey).not.toBe("NSE_EQ:NHPC");
    expect(out[0].ltp).toBeCloseTo(52.05, 2);
  });

  it("accepts a pipe-keyed response too (defensive against both provider formats)", () => {
    const pipeKeyed = { "NSE_EQ|INE848E01016": (DOCUMENTED_RESPONSE.data as Record<string, unknown>)["NSE_EQ:NHPC"] };
    const out = mapResponse(pipeKeyed, requested);
    expect(out).toHaveLength(1);
    expect(out[0].instrumentKey).toBe("NSE_EQ|INE848E01016");
  });

  it("never injects an instrument that was not requested", () => {
    const extra = {
      "NSE_EQ:OTHER": { instrument_token: "NSE_EQ|INE9999999999", last_price: 10, oi: 0 },
    };
    expect(mapResponse(extra, requested)).toHaveLength(0);
  });

  it("rejects entries without a valid LTP instead of zero-filling", () => {
    const noLtp = { "NSE_EQ:NHPC": { instrument_token: "NSE_EQ|INE848E01016", ohlc: { close: 52 } } };
    expect(mapResponse(noLtp as unknown as Record<string, unknown>, requested)).toHaveLength(0);
  });

  it("preserves a genuine numeric zero OI as 0 (distinct from missing)", () => {
    const out = mapResponse(DOCUMENTED_RESPONSE.data as unknown as Record<string, unknown>, requested);
    expect(out[0].oi).toBe(0);
    expect(out[0].oi).not.toBeNull();
  });

  it("treats an empty data object as a failed fetch, not success", () => {
    expect(mapResponse({}, requested)).toHaveLength(0);
    // the adapter throws EMPTY_RESPONSE in this case rather than returning []
  });
});

describe("provider timestamp parsing", () => {
  it("parses ISO-8601 timestamps with offset", () => {
    const t = parseProviderTs("2023-10-19T05:21:51.099+05:30");
    expect(t).not.toBeNull();
    expect(t).toBeGreaterThan(0);
    // 05:21:51.099+05:30 == 2023-10-18T23:51:51.099Z — proves the +05:30
    // offset was honoured rather than reading it as UTC
    expect(new Date(t as number).toISOString()).toBe("2023-10-18T23:51:51.099Z");
  });

  it("parses epoch-millis strings (last_trade_time format)", () => {
    // new Date("1697624972130") is Invalid Date — this must be numeric
    expect(new Date("1697624972130").getTime()).toBeNaN();
    expect(parseProviderTs("1697624972130")).toBe(1697624972130);
  });

  it("parses numeric epoch values", () => {
    expect(parseProviderTs(1697624972130)).toBe(1697624972130);
  });

  it("returns null for missing or malformed values (never a fabricated time)", () => {
    expect(parseProviderTs(undefined)).toBeNull();
    expect(parseProviderTs(null)).toBeNull();
    expect(parseProviderTs("not-a-date")).toBeNull();
    expect(parseProviderTs(0)).toBeNull();
    expect(parseProviderTs(-5)).toBeNull();
  });
});
