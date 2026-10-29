/**
 * Manual "Scan Now".
 *
 * Runs the EXACT same pipeline as the 30-second automatic cycle
 * (`engine.runScanCycle`), so a manual scan can never diverge from an
 * automatic one. Overlapping scans are rejected rather than queued, and the
 * shared rate limiter still applies — a manual scan cannot bypass provider
 * limits or spawn duplicate background requests.
 */
import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/market/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const e = await ensureBoot();
  return NextResponse.json({ ok: true, scan: e.scanState, asOf: Date.now() });
}

export async function POST() {
  const e = await ensureBoot();

  // Already running → report the running state instead of starting a second scan
  if (e.scanState.status === "RUNNING") {
    return NextResponse.json({
      ok: false,
      state: "ALREADY_RUNNING",
      message: "A scan is already in progress — duplicate scans are not started.",
      scan: e.scanState,
      asOf: Date.now(),
    }, { status: 409 });
  }

  if (e.getStatus().tokenStatus !== "VALID") {
    // Still run the cycle (historical/EOD paths work without a token) but say so.
    const scan = await e.runScanCycle("MANUAL");
    return NextResponse.json({
      ok: true,
      state: "DEGRADED",
      message: "Scanned in degraded mode — live quotes, option chains and order flow require an Upstox token.",
      scan,
      asOf: Date.now(),
    });
  }

  const scan = await e.runScanCycle("MANUAL");
  return NextResponse.json({
    ok: scan.status === "COMPLETED" || scan.status === "PARTIAL",
    state: scan.status,
    message:
      scan.status === "COMPLETED" ? `Scan completed — ${scan.evaluated} instruments evaluated.`
      : scan.status === "PARTIAL" ? `Partial scan — ${scan.evaluated} evaluated, ${scan.failed} stage failure(s). Remaining instruments refresh on the rotating schedule.`
      : scan.status === "RATE_LIMITED" ? "Provider rate limit reached — backing off before the next cycle."
      : `Scan failed: ${scan.error ?? "unknown error"}`,
    scan,
    asOf: Date.now(),
  });
}
