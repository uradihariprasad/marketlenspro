/**
 * Option-chain capability tests (Prompt §3).
 *
 * Capability is resolved from the LIVE instrument master: an underlying is
 * offered only when it actually has listed CE/PE contracts. This test hits
 * the real Upstox asset server (no token required) to prove stock chains are
 * genuinely supported, rather than assuming F&O eligibility implies options.
 */
import { describe, it, expect } from "vitest";
import { loadUniverse } from "../src/lib/market/upstox";

describe("option underlyings resolved from the instrument master", () => {
  it(
    "indices AND F&O stocks expose real listed contracts with future expiries",
    { timeout: 90_000 },
    async () => {
      const u = await loadUniverse();
      expect(u.optionUnderlyings.size).toBeGreaterThan(100);

      // indices are present and flagged as index underlyings
      const nifty = u.indices.NIFTY!;
      const niftyOpt = u.optionUnderlyings.get(nifty.instrumentKey);
      expect(niftyOpt).toBeDefined();
      expect(niftyOpt!.isIndex).toBe(true);
      expect(niftyOpt!.expiries.length).toBeGreaterThan(0);

      // a liquid stock underlying resolves by its EQUITY key
      const rel = u.foEquities.find((e) => e.tradingSymbol === "RELIANCE")!;
      expect(rel.instrumentKey.startsWith("NSE_EQ|")).toBe(true);
      const relOpt = u.optionUnderlyings.get(rel.instrumentKey);
      expect(relOpt).toBeDefined();
      expect(relOpt!.isIndex).toBe(false);
      expect(relOpt!.contractCount).toBeGreaterThan(20);
      expect(relOpt!.expiries.length).toBeGreaterThan(0);

      // every advertised expiry is today or later — expired contracts dropped
      const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
      for (const [, o] of u.optionUnderlyings) {
        for (const e of o.expiries) expect(e >= today).toBe(true);
        expect(o.expiries).toEqual([...o.expiries].sort()); // ascending
      }

      // a large share of the F&O equity universe has option chains, and the
      // ones that do not are simply absent (never fabricated)
      const withOptions = u.foEquities.filter((e) => u.optionUnderlyings.has(e.instrumentKey));
      expect(withOptions.length).toBeGreaterThan(50);
      expect(withOptions.length).toBeLessThanOrEqual(u.foEquities.length);
    }
  );

  it(
    "an instrument without listed contracts is reported unsupported, not guessed",
    { timeout: 90_000 },
    async () => {
      const u = await loadUniverse();
      expect(u.optionUnderlyings.has("NSE_EQ|INVALID_UNDERLYING")).toBe(false);
    }
  );
});
