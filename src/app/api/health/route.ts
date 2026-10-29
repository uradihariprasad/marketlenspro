import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const started = Date.now();
  try {
    // Render uses this during deploys. A bounded response is important: an
    // unreachable database should produce a clear 503, not a hanging check.
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("database health timeout")), 4_000)
      ),
    ]);
    return Response.json(
      { ok: true, database: "connected", latencyMs: Date.now() - started },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return Response.json(
      { ok: false, database: "unavailable", latencyMs: Date.now() - started },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
