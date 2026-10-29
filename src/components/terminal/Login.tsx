"use client";

import { useState } from "react";
import { ShieldCheck, KeyRound, Loader2, AlertTriangle, Radio, Layers, TrendingUp } from "lucide-react";

export default function Login({ onLoggedIn, tokenStatus, onBrowse }: { onLoggedIn: () => void; tokenStatus: string; onBrowse?: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) setError(data.error ?? "Login failed");
      else onLoggedIn();
    } catch {
      setError("Network error — could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden px-6">
      <div className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(700px 380px at 50% 0%, rgba(34,211,238,0.10), transparent 65%), radial-gradient(600px 400px at 85% 100%, rgba(167,139,250,0.08), transparent 60%)",
        }}
      />
      <div className="fade-in relative w-full max-w-lg">
        <div className="glow-cyan panel p-5 sm:p-10">
          <div className="mb-6 flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-xl border border-cyan-400/30 bg-cyan-400/10">
              <TrendingUp size={20} className="text-cyan-300" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-slate-100">F&O Intraday Intelligence</h1>
              <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">NIFTY · SENSEX · F&O Stocks · Decision Support</p>
            </div>
          </div>

          {tokenStatus === "EXPIRED" && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-[12px] text-amber-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span>The stored Upstox token has expired (tokens typically expire at 03:30 IST). Paste a fresh access token to resume live data.</span>
            </div>
          )}

          <label className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
            <KeyRound size={13} /> Upstox API access token
          </label>
          <input
            type="password"
            className="token-input"
            placeholder="Paste your daily access token…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && token && void submit()}
            autoComplete="off"
            spellCheck={false}
          />

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-400/30 bg-rose-400/10 p-3 text-[12px] text-rose-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            onClick={() => void submit()}
            disabled={busy || token.trim().length < 20}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-400 py-3 text-[13px] font-bold uppercase tracking-[0.14em] text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Radio size={16} />}
            {busy ? "Validating with Upstox…" : "Connect live market data"}
          </button>

          {onBrowse && (
            <button
              onClick={onBrowse}
              className="mt-2.5 w-full rounded-xl border border-slate-700 py-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
            >
              Continue with historical data (read-only, no token)
            </button>
          )}

          <div className="mt-6 space-y-2 border-t border-slate-800 pt-4">
            <div className="flex items-start gap-2 text-[11px] text-slate-500">
              <ShieldCheck size={13} className="mt-0.5 shrink-0 text-emerald-400" />
              <span>Your token is validated against the Upstox profile endpoint, stored server-side only, and is never sent back to the browser or logged.</span>
            </div>
            <div className="flex items-start gap-2 text-[11px] text-slate-500">
              <Layers size={13} className="mt-0.5 shrink-0 text-violet-400" />
              <span>Generate a token via the Upstox developer console OAuth flow. Without a token, only historical candles load; live quotes, chains and order-flow stay UNAVAILABLE — nothing is fabricated.</span>
            </div>
          </div>
        </div>
        <p className="mt-4 text-center text-[11px] text-slate-600">
          Decision-support tool. No signal is a guarantee. Trade with your own risk management.
        </p>
      </div>
    </div>
  );
}
