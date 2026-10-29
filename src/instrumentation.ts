export async function register() {
  // Start the market-data engine once, on the server runtime only.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureBoot } = await import("@/lib/market/engine");
    await ensureBoot();
  }
}
