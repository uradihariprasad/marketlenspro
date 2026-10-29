/**
 * Aggregated terminal snapshot: status, index cards, scanner, signals,
 * option-chain analytics, capabilities, counters, alerts.
 * One endpoint → the UI poll stays simple and cheap.
 */
import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/market/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const e = await ensureBoot();
  const status = e.getStatus();
  const u = e.universe;

  const instruments = u
    ? {
        indices: (["NIFTY", "SENSEX", "BANKNIFTY"] as const)
          .map((k) => {
            const meta = u.indices[k];
            return meta ? { instrumentKey: meta.instrumentKey, label: k === "NIFTY" ? "NIFTY 50" : k === "SENSEX" ? "SENSEX" : "NIFTY BANK", tick: meta.tickSize } : null;
          })
          .filter(Boolean),
        futures: (["NIFTY", "SENSEX", "BANKNIFTY"] as const)
          .map((k) => {
            const f = u.futures.get(k)?.[0];
            return f ? { instrumentKey: f.instrumentKey, label: e.displayNameOf(f.instrumentKey), tick: f.tickSize } : null;
          })
          .filter(Boolean),
        stocks: u.foEquities.slice(0, 220).map((eq) => ({ instrumentKey: eq.instrumentKey, label: eq.tradingSymbol, tick: eq.tickSize })),
      }
    : { indices: [], futures: [], stocks: [] };

  const chains: Record<string, unknown> = {};
  if (u) {
    for (const k of ["NIFTY", "SENSEX", "BANKNIFTY"] as const) {
      const meta = u.indices[k];
      if (!meta) continue;
      const c = e.chainOptionsFor(meta.instrumentKey);
      if (c) chains[k] = c;
    }
  }

  // Bounded chain summary — per-underlying status only, never every strike.
  const chainCatalog = u
    ? [...u.optionUnderlyings.values()]
        .map((o) => {
          const st = e.chainStatus.get(o.underlyingKey);
          return {
            underlyingKey: o.underlyingKey,
            symbol: o.symbol,
            isIndex: o.isIndex,
            expiries: o.expiries.slice(0, 6),
            state: st?.state ?? "PENDING",
            at: st?.at ?? null,
            note: st?.note ?? "not yet fetched",
          };
        })
        .sort((a, b) => Number(b.isIndex) - Number(a.isIndex) || a.symbol.localeCompare(b.symbol))
    : [];

  const alerts = await e.recentAlerts();

  return NextResponse.json({
    status,
    indexCards: e.indexCards(),
    scanner: e.scanner,
    eodScanner: e.getEodScanner(),
    signals: e.signalsBoard,
    chains,
    chainCatalog,
    chainStats: {
      total: chainCatalog.length,
      loaded: chainCatalog.filter((c) => c.state === "LOADED").length,
      pending: chainCatalog.filter((c) => c.state === "PENDING").length,
      failed: chainCatalog.filter((c) => c.state === "FAILED").length,
      unsupported: chainCatalog.filter((c) => c.state === "UNSUPPORTED").length,
    },
    analysisCoverage: e.analysisCoverage(),
    instruments,
    alerts,
    displayName: undefined,
  });
}
