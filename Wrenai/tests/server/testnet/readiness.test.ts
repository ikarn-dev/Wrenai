import { base58 } from "@scure/base";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/testnet/rpc", () => ({ testnetChain: vi.fn(async () => undefined), testnetRpc: vi.fn() }));

import { providerReady, VERIFIER_HASH } from "@/server/testnet/provider";
import { testnetRpc } from "@/server/testnet/rpc";
import { configureTestnet } from "./context";

function healthy(source = "coingecko", updatedAt = new Date().toISOString()): void {
  configureTestnet();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            network: "testnet",
            verifier: "verifier.tidepool-sandbox.testnet",
            ok: true,
            checks: { prices: { ok: true, source, updatedAt } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  vi.mocked(testnetRpc).mockResolvedValue({ code_hash: base58.encode(Buffer.from(VERIFIER_HASH, "hex")) });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("testnet provider readiness", () => {
  it("checks the independently observed finalized code hash without downloading WASM", async () => {
    healthy();
    await expect(providerReady()).resolves.toBeUndefined();
    expect(testnetRpc).toHaveBeenCalledWith("query", {
      request_type: "view_account",
      account_id: "verifier.tidepool-sandbox.testnet",
      finality: "final",
    });
  });
  it("blocks an upgraded or substituted verifier", async () => {
    healthy();
    vi.mocked(testnetRpc).mockResolvedValue({ code_hash: base58.encode(Buffer.alloc(32)) });
    await expect(providerReady()).rejects.toThrow("code changed");
  });
  it("does not present fallback or stale provider prices as live", async () => {
    healthy("fallback");
    await expect(providerReady()).rejects.toThrow();
    healthy("coingecko", new Date(Date.now() - 61000).toISOString());
    await expect(providerReady()).rejects.toThrow("stale");
  });
});
