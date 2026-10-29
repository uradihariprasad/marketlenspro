# Repository Audit Report — F&O Intraday Intelligence

## 1. What the repository actually contained (verified, not assumed)

Inspection of the working tree found a **bare Next.js 16 + PostgreSQL/Drizzle
starter**, and nothing else:

| Expectation (from the brief) | Finding |
|---|---|
| `src/lib/market/srEngine.ts` (existing S/R engine) | **Absent** — file did not exist |
| `src/components/PriceChart.tsx` | **Absent** — created fresh (Lightweight Charts v4) |
| FastAPI / Python backend | **Absent** — no Python runtime exists in this deployment |
| Broker integration / WebSocket handlers | **Absent** |
| Data models / migrations | **Absent** — `schema.ts` was an empty stub |

Pre-existing files: Next.js app shell, `/api/health`, empty Drizzle schema, DB
pool. No F&O logic at all. Conclusion: this was a **greenfield build**, not a
completion of working code. Nothing was "assumed to work" — everything was
implemented and explicitly type-checked.

## 2. Architecture decision (documented per rule 12)

The brief targets FastAPI + a separate React/Vite frontend. The deployment
platform for this project is a **single Next.js (App Router) fullstack runtime
with PostgreSQL/Drizzle**; two long-lived web servers are not available.
Therefore the canonical backend layer was implemented as a **server-side
TypeScript module tree** (`src/lib/market/*`) with the same logical separation
the brief demands — broker adapter (`upstox.ts`), ingestion/orchestration
(`engine.ts`), candles (`candles.ts`), indicators, structure, volume profile,
S/R engine (`srEngine.ts`), order flow (`orderflow.ts`), options engine, scanner,
and trade-decision engine (`signals.ts`) — exposed through typed API routes. The
frontend renders validated backend outputs only; it does not reimplement trading
logic. If a separate FastAPI service is later introduced, the provider-independent
canonical models in `types.ts` are the port seam.

## 3. Provider verification performed (rule 5)

Verified live from this environment before coding:

- `GET /v2/historical-candle/...` — HTTP 200 without auth; used for candle
  hydration (index candles verified to carry zero volume).
- Instrument master (`assets.upstox.com/.../NSE.json.gz` / `BSE.json.gz`) —
  reachable, ~2 MB gzipped; fields sampled (`segment`, `instrument_type`,
  `instrument_key`, `expiry`, `tick_size`, `trading_symbol`).
- Token-gated surfaces (quotes, option chain) are documented in
  `upstox.ts` with token lifecycle, limits and error handling.
- REST quote packets carry **no aggressor-side trade flags / trade ids** →
  order-flow exactness is impossible on this surface. Hence the capability
  gate: EXACT = unavailable, ESTIMATED = tick-rule, always labelled.

## 4. Rule-by-rule compliance mapping (non-negotiable rules)

| # | Rule | Implementation |
|---|---|---|
| 1 | No mock data | All figures from Upstox or derived from it; empty/quality states shown otherwise |
| 2 | No placeholders | Every module fully implemented; capability gaps are explicit statuses |
| 3 | No false claims | System tab shows live capability matrix, engine counters |
| 4 | No fake Delta/CVD | `ESTIMATED` tick-rule labels everywhere; `UNAVAILABLE` where impossible |
| 5 | OI-only ≠ confirmed S/R | `srEngine.ts` provenance groups; upgrade needs price-action; provenance preserved |
| 6 | No depth- inferred aggressor | Depth used only for bid/ask display |
| 7 | No look-ahead | Pivots emitted only after right-bar confirmation; closed-bar triggers only |
| 8 | No forced trades | `deriveSignals` returns `[]`; UI renders "No qualifying setups" |
| 9 | Score ≠ probability | Labelled confluence score in UI + docs |
| 10 | No fabricated fills | Gap report; volume profile `UNAVAILABLE` without volume |
| 11 | No secret exposure | Token server-side only; login API returns booleans; error redaction |
| 12 | Architecture preserved/documented | This file; single Next.js runtime decision |
| 13 | Provenance & timestamp semantics | `Quote.exchangeTs/lastTradeTs/localTs` separated; IST session model in `types.ts` |
| 14 | Traceable signals | `trace.rules` + `trace.inputs` persisted to `signals` table |
| 15 | Honest capability status | Capability matrix UI + per-feature method/limitation |

## 5. Known limitations (honest)

- REST polling (~8 s) is not tick-by-tick; estimated flow merges intra-interval trades.
- Historical tick replay unavailable on Upstox REST.
- RVOL uses a uniform intraday-distribution approximation (disclosed in UI).
- Stock-level option chains are not polled (index chains only) — documented in the Option Desk.
- The protobuf WebSocket feed is out of scope for this deployment.
