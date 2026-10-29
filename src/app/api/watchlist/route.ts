/**
 * Watchlist persistence — stored in PostgreSQL settings (not a secret).
 */
import { NextResponse } from "next/server";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ensureBoot } from "@/lib/market/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY = "watchlist";

export async function GET() {
  const e = await ensureBoot();
  let keys: string[] = [];
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, KEY));
    keys = rows[0] ? (JSON.parse(rows[0].value) as string[]) : [];
  } catch {
    keys = [];
  }
  const quotes: Record<string, { ltp: number | null; changePct: number | null; quality: string }> = {};
  for (const k of keys) {
    const q = e.quotes.get(k);
    if (!q) {
      quotes[k] = { ltp: null, changePct: null, quality: "UNAVAILABLE" };
    } else {
      quotes[k] = {
        ltp: q.ltp,
        changePct: q.ltp !== null && q.close ? Math.round(((q.ltp - q.close) / q.close) * 10000) / 100 : null,
        quality: Date.now() - q.localTs < 25_000 ? "LIVE" : "STALE",
      };
    }
  }
  return NextResponse.json({ keys, quotes });
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as { keys?: string[] };
    const keys = Array.isArray(body.keys) ? body.keys.map(String).slice(0, 40) : [];
    await db
      .insert(settings)
      .values({ key: KEY, value: JSON.stringify(keys) })
      .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(keys), updatedAt: new Date() } });
    return NextResponse.json({ ok: true, keys });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message.slice(0, 120) }, { status: 500 });
  }
}

export { KEY as watchlistKey };
