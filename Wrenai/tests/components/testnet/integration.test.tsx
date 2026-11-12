import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentCatalog } from "@/components/agents/catalog";
import { AppNetworkProvider } from "@/components/shell/network-context";
import { postTrading, readTrading } from "@/components/trading/trading-api";
import { networkRoute, TESTNET_ROUTES } from "@/shared/app-routes";
import { testnetAgentToolSchema } from "@/shared/testnet-agents";
import { testnetMarketRead } from "@/shared/testnet-markets";

afterEach(() => vi.unstubAllGlobals());
describe("existing app UI with testnet data", () => {
  it("retains every existing navigation section inside the testnet shell", () => {
    for (const [path, href] of Object.entries(TESTNET_ROUTES)) {
      const route = Object.keys(TESTNET_ROUTES).find((key) => key === path);
      expect(route).toBeDefined();
      expect(href.startsWith("/testnet/")).toBe(true);
    }
    expect(networkRoute("testnet", "/agents")).toBe("/testnet/agents");
    expect(networkRoute("testnet", "/perps")).toBe("/testnet/perps");
    expect(networkRoute("mainnet", "/agents")).toBe("/agents");
  });
  it("reuses the catalog with only the five compatible testnet agents", () => {
    const html = renderToStaticMarkup(
      <AppNetworkProvider network="testnet">
        <AgentCatalog testnet tools={testnetAgentToolSchema.options} />
      </AppNetworkProvider>,
    );
    expect((html.match(/<article/g) ?? []).length).toBe(5);
    expect(html).toContain("Payments Agent");
    expect(html).not.toContain("Private Payments Agent");
    expect(html).not.toContain("Perps Agent");
    expect(html).not.toContain("Meme Hunter Agent");
    expect(html).toContain("/testnet/agents?create=dca");
    expect(html).toContain("/testnet/chat?tool=spot_trader");
  });
  it("leaves the mainnet catalog and its routes intact", () => {
    const html = renderToStaticMarkup(createElement(AgentCatalog));
    expect((html.match(/<article/g) ?? []).length).toBe(7);
    expect(html).toContain("Private Payments Agent");
    expect(html).toContain("/agents?create=perps");
    expect(html).not.toContain("/testnet/");
  });
  it("cannot read private mainnet balances through the market adapter", () => {
    expect(testnetMarketRead("/api/trading/spot-markets?view=metrics")).toBe(
      "/api/testnet/markets?view=metrics",
    );
    expect(testnetMarketRead("/api/portfolio/insights?card=spot")).toBe(
      "/api/testnet/markets?view=insights&card=spot",
    );
    expect(testnetMarketRead("/api/trading/account")).toBeNull();
    expect(testnetMarketRead("/api/agents/budget")).toBeNull();
    expect(testnetMarketRead("/api/claims")).toBeNull();
  });
  it("blocks mainnet mutations before fetching, even if a mainnet session also exists", async () => {
    vi.stubGlobal("window", { location: { pathname: "/testnet/spot" } });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await postTrading("/api/trading/orders", { step: "confirm" }, z.unknown())).toMatchObject({
      ok: false,
      message: expect.stringContaining("Mainnet only"),
    });
    await expect(
      readTrading("/api/trading/account", z.unknown(), new AbortController().signal),
    ).rejects.toThrow("Mainnet only");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("routes mainnet public market observations through the testnet-authorized read endpoint", async () => {
    vi.stubGlobal("window", { location: { pathname: "/testnet/spot" } });
    const fetch = vi.fn(async (_path: string) => Response.json({ ok: true, value: { count: 3 } }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      readTrading("/api/trading/spot-markets", z.object({ count: z.number() }), new AbortController().signal),
    ).resolves.toEqual({ count: 3 });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/testnet/markets?view=spot");
  });
});
