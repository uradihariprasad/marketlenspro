/**
 * Phase 3.8 tests: approximate volume-profile conservation & node math,
 * plus protobuf decoder / secret encryption / replay determinism.
 */
import { describe, it, expect } from "vitest";
import { computeProfile } from "../src/lib/market/volumeProfile";
import { encryptSecret, decryptSecret } from "../src/lib/market/secure";
import { runReplay } from "../src/lib/market/replay";
import { Candle } from "../src/lib/market/types";

describe("approximate volume profile", () => {
  const candles: Candle[] = [];
  {
    const base = Date.parse("2026-10-23T09:15:00+05:30");
    for (let i = 0; i < 30; i++) {
      const c = 100 + (i % 6) * 2; // oscillate 100..110
      candles.push({ t: base + i * 300_000, o: c - 1, h: c + 2, l: c - 2, c, v: 1000, closed: true });
    }
  }

  it("allocates volume conserving the original candle volume (±2% rounding)", () => {
    const p = computeProfile(candles, 0.05);
    expect(p).not.toBeNull();
    expect(p!.mode).toBe("APPROXIMATE");
    const orig = candles.reduce((a, c) => a + c.v, 0);
    expect(p!.totalVolume).toBe(orig);
    const binsum = p!.bins.reduce((a, b) => a + b.v, 0);
    expect(Math.abs(binsum - orig) / orig).toBeLessThan(0.02);
  });

  it("POC inside value area, VAL < POC < VAH, bin edges tick-aligned", () => {
    const p = computeProfile(candles, 0.05)!;
    expect(p.poc).not.toBeNull();
    expect(p.val!).toBeLessThan(p.poc!);
    expect(p.poc!).toBeLessThan(p.vah!);
    expect(p.vah! - p.val!).toBeGreaterThan(0);
    expect(Math.abs(p.binSize / 0.05 - Math.round(p.binSize / 0.05))).toBeLessThan(1e-9);
  });

  it("returns UNAVAILABLE for zero-volume (index-like) candles", () => {
    const zero = candles.map((c) => ({ ...c, v: 0 }));
    const p = computeProfile(zero, 0.05);
    expect(p?.mode).toBe("UNAVAILABLE");
    expect(p?.note).toMatch(/unavailable/i);
  });
});

describe("credential encryption", () => {
  it("encrypts and decrypts round-trip; ciphertext is not plaintext", () => {
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-payload";
    const enc = encryptSecret(token);
    expect(enc.startsWith("v1.")).toBe(true);
    expect(enc.includes(token)).toBe(false);
    expect(decryptSecret(enc)).toBe(token);
  });

  it("legacy plaintext rows read back unchanged for migration", () => {
    expect(decryptSecret("plainlegacytoken")).toBe("plainlegacytoken");
  });

  it("a different key source cannot decrypt (rotation safety)", () => {
    const prev = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-A-rotation";
    const enc = encryptSecret("secret-token-x");
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-B-rotation";
    expect(decryptSecret(enc)).toBeNull();
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-A-rotation";
    expect(decryptSecret(enc)).toBe("secret-token-x");
    if (prev === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = prev;
  });
});

describe("historical replay (no look-ahead)", () => {
  function trendingSession(): Candle[] {
    const base = Date.parse("2026-10-23T09:15:00+05:30");
    const out: Candle[] = [];
    let p = 100;
    // a full session of 75 five-minute bars (375 one-minute bars)
    for (let i = 0; i < 375; i++) {
      p += i < 130 ? 0.35 : i < 220 ? -0.28 : 0.31;
      out.push({ t: base + i * 60_000, o: p - 0.3, h: p + 0.6, l: p - 0.8, c: p, v: 5_000 + i * 10, closed: true });
    }
    return out;
  }

  it("is deterministic and only emits steps after warm-up (no signals before history exists)", () => {
    const args = { instrumentKey: "T|R", oneMin: trendingSession(), timeframeMin: 5, tickSize: 0.05, sessionDate: "2026-10-23" };
    const r1 = runReplay(args);
    const r2 = runReplay(args);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    if ("error" in r1) throw new Error(r1.error);
    const sessionStart = Date.parse("2026-10-23T09:15:00+05:30");
    const warmEarliest = sessionStart + 40 * 5 * 60_000 - 5 * 60_000;
    for (const s of r1.signals) expect(s.firstSeenAt).toBeGreaterThanOrEqual(warmEarliest);
  });

  it("short history returns an explicit error instead of fabricated results", () => {
    const r = runReplay({
      instrumentKey: "T|S",
      oneMin: trendingSession().slice(0, 10),
      timeframeMin: 5,
      tickSize: 0.05,
      sessionDate: "2026-10-23",
    });
    expect("error" in r).toBe(true);
  });
});
