/**
 * Selected-instrument option chain.
 *
 * The terminal payload intentionally does NOT embed every strike of every
 * stock (that would be a huge response on each refresh). The UI requests the
 * chain for the instrument the user actually selected through this route,
 * which serves the engine's cached, validated chain.
 *
 * Honest statuses: LOADED / PENDING / UNSUPPORTED / FAILED / REQUIRES_TOKEN.
 */
import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/market/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("instrumentKey") ?? "";
  if (!raw) return NextResponse.json({ ok: false, state: "FAILED", error: "instrumentKey required" }, { status: 400 });

  const e = await ensureBoot();
  const underlyingKey = e.resolveChainKey(raw) ?? raw;
  const u = e.universe;
  const meta = u?.optionUnderlyings.get(underlyingKey) ?? null;
  const symbol = e.displayNameOf(underlyingKey);

  if (!u) {
    return NextResponse.json({ ok: false, state: "PENDING", underlyingKey, symbol, error: "instrument master still loading" }, { status: 503 });
  }
  // Capability is resolved from the instrument master: no listed contracts
  // means the provider genuinely has no chain for this underlying.
  if (!meta) {
    return NextResponse.json({
      ok: false,
      state: "UNSUPPORTED",
      underlyingKey,
      symbol,
      error: `${symbol} has no listed option contracts in the Upstox instrument master — option chain is not available for this instrument.`,
    });
  }
  if (e.getStatus().tokenStatus !== "VALID") {
    return NextResponse.json({
      ok: false,
      state: "REQUIRES_TOKEN",
      underlyingKey,
      symbol,
      expiries: meta.expiries,
      error: "Option chains require a valid Upstox access token.",
    });
  }

  // prioritise this underlying on the next scheduler pass
  e.setFocus(raw);
  const chain = e.chainOptionsFor(underlyingKey);
  const status = e.chainStatus.get(underlyingKey) ?? null;

  if (!chain) {
    return NextResponse.json({
      ok: false,
      state: status?.state ?? "PENDING",
      underlyingKey,
      symbol,
      expiries: meta.expiries,
      note: status?.note ?? "chain queued for the next scheduler cycle",
      error: status?.state === "FAILED" ? `Chain request failed: ${status.note}` : null,
    });
  }

  return NextResponse.json({
    ok: true,
    state: "LOADED",
    underlyingKey,
    symbol,
    expiries: meta.expiries,
    isIndex: meta.isIndex,
    chain,
    status,
    ageMs: Date.now() - chain.capturedAt,
    asOf: Date.now(),
  });
}
