import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("Render deployment contract", () => {
  const blueprint = read("render.yaml");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; dependencies: Record<string, string> };

  it("uses reproducible production build/start commands and a health check", () => {
    expect(blueprint).toContain("buildCommand: npm ci && npm run build");
    expect(blueprint).toContain("startCommand: npm start -- -H 0.0.0.0 -p $PORT");
    expect(blueprint).toContain("healthCheckPath: /api/health");
    expect(pkg.scripts.build).toBe("next build");
    expect(pkg.scripts.start).toBe("next start");
  });

  it("wires PostgreSQL and generates a server-only encryption key", () => {
    expect(blueprint).toContain("fromDatabase:");
    expect(blueprint).toContain("property: connectionString");
    expect(blueprint).toMatch(/TOKEN_ENCRYPTION_KEY[\s\S]*generateValue: true/);
    expect(blueprint).not.toMatch(/- key:\s*UPSTOX_(?:ACCESS_)?TOKEN/i);
    expect(blueprint).not.toMatch(/- key:\s*UPSTOX_API_KEY/i);
  });

  it("pins Node and deploys exactly one scheduler instance", () => {
    expect(read(".node-version").trim()).toMatch(/^22\./);
    expect(blueprint).toContain("numInstances: 1");
    expect(blueprint).toContain("POLL_QUOTES_MS");
    expect(blueprint).toContain("QUOTE_BATCH_SIZE");
  });
});

describe("responsive terminal contract", () => {
  const terminal = read("src/components/terminal/Terminal.tsx");
  const css = read("src/app/globals.css");
  const layout = read("src/app/layout.tsx");
  const chart = read("src/components/terminal/PriceChart.tsx");

  it("provides touch-friendly safe-area mobile navigation", () => {
    expect(terminal).toContain("mobile-bottom-nav");
    expect(terminal).toContain("mobile-nav-item");
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).toContain("min-height: 48px");
  });

  it("has a device-width viewport with cover-safe rendering", () => {
    expect(layout).toContain('width: "device-width"');
    expect(layout).toContain('viewportFit: "cover"');
    expect(layout).toContain('themeColor: "#05070b"');
  });

  it("makes dense tables intentionally scrollable and inputs iOS-safe", () => {
    expect(css).toContain("-webkit-overflow-scrolling: touch");
    expect(css).toMatch(/input\.token-input,[\s\S]*font-size: 16px/);
    expect(css).toMatch(/\.tbl \{[\s\S]*min-width: 700px/);
  });

  it("resizes chart width and height for phone viewports", () => {
    expect(chart).toContain("e.contentRect.width < 640");
    expect(chart).toContain("responsiveHeight");
    expect(chart).toContain("barSpacing");
  });
});
