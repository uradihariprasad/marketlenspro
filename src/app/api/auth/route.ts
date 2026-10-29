/**
 * Auth routes — Upstox access token lifecycle.
 * The token is validated server-side and stored server-side only.
 * Responses NEVER echo the token back (rule 11).
 */
import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/market/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const e = await ensureBoot();
  const s = e.getStatus();
  return NextResponse.json({
    connected: s.tokenStatus === "VALID",
    tokenStatus: s.tokenStatus,
    profileName: s.profileName,
  });
}

export async function POST(req: Request) {
  let token = "";
  try {
    const body = (await req.json()) as { token?: string };
    token = String(body.token ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }
  if (!token || token.length < 20) {
    return NextResponse.json({ ok: false, error: "Please paste a full Upstox access token." }, { status: 400 });
  }
  const e = await ensureBoot();
  const result = await e.login(token);
  return NextResponse.json(result, { status: result.ok ? 200 : 401 });
}

export async function DELETE() {
  const e = await ensureBoot();
  await e.logout();
  return NextResponse.json({ ok: true });
}
