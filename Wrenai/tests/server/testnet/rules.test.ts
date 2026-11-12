import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { priceTrigger } from "@/server/testnet/agents";
import { testnetEnv } from "@/server/testnet/config";
import { parseChatPayment } from "@/shared/chat-payment-command";
import { resolveTestnetAsset, TESTNET_ASSETS, testnetRuleSchema, tokenText } from "@/shared/testnet";
import { configureTestnet, USDC, USDT } from "./context";

afterEach(() => vi.unstubAllEnvs());
describe("testnet identity and strategy rules", () => {
  it("keeps testnet available alongside mainnet without a network switch", () => {
    configureTestnet();
    vi.stubEnv("WRENAI_NETWORK", "mainnet");
    vi.stubEnv("TESTNET_RPC_URL", "https://rpc.mainnet.fastnear.com");
    expect(testnetEnv().TESTNET_RPC_URL).toBe("https://rpc.testnet.fastnear.com");
    vi.stubEnv("WRENAI_NETWORK", undefined);
    expect(testnetEnv().TESTNET_RPC_URL).toBe("https://rpc.testnet.fastnear.com");
    vi.stubEnv("APP_URL", "http://localhost:3000");
    expect(testnetEnv().origin).toBe("http://localhost:3000");
    vi.stubEnv("APP_URL", "ftp://example.com");
    expect(() => testnetEnv()).toThrow("APP_URL");
  });
  it("derives the guest executor from its actual key rather than an independent account setting", () => {
    configureTestnet();
    vi.stubEnv("TESTNET_POOL_ACCOUNT_ID", "wrong.testnet");
    expect(testnetEnv().TESTNET_POOL_ACCOUNT_ID).toBe(
      "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c",
    );
  });
  it("rejects reuse of the mainnet encryption master", () => {
    configureTestnet();
    vi.stubEnv("KEY_ENCRYPTION_KEY", Buffer.alloc(32, 2).toString("base64"));
    expect(() => testnetEnv()).toThrow("independent");
  });
  it("never aliases native NEAR to a mintable mock token", () => {
    expect(resolveTestnetAsset("NEAR")?.id).toBe("native:near");
    expect(resolveTestnetAsset("wNEAR")?.contract).toBe("wnear.tidepool-sandbox.testnet");
    expect(resolveTestnetAsset("wrap.near")).toBeNull();
    expect(TESTNET_ASSETS.some((a) => a.contract === "wrap.testnet")).toBe(false);
  });
  it("formats exact units without scientific notation or precision loss", () => {
    expect(tokenText("1", 24)).toBe("0.000000000000000000000001");
    expect(tokenText("1234567", 6)).toBe("1.234567");
  });
  it("keeps the reviewed grant and finite caps without quota environment variables", () => {
    configureTestnet();
    const config = testnetEnv();
    expect(config.allowances.find((a) => a.assetId === "native:near")?.units).toBe(10n ** 23n);
    expect(config.allowances.find((a) => a.assetId === USDC)?.units).toBe(5000000n);
    expect(config.allowances.find((a) => a.assetId === USDT)?.units).toBe(5000000n);
    expect(config.TESTNET_MAX_ACTIONS_PER_DAY).toBe(30);
    expect(config.TESTNET_MAX_ACTIONS_PER_GUEST).toBe(10);
    expect(config.reserve).toBe(10n ** 24n);
    expect(config.allowances.every((a) => a.cap > 0n)).toBe(true);
  });
  it("does not invent a guest key when credentials are missing", () => {
    configureTestnet();
    vi.stubEnv("TESTNET_POOL_SEED", undefined);
    expect(() => testnetEnv()).toThrow("wallet seed");
  });
  it("parses explicit testnet payments without enabling mainnet payment on that session", () => {
    expect(parseChatPayment("send 1 USDC to alice.testnet on testnet", "testnet")).toMatchObject({
      amount: "1",
      token: "usdc",
      recipient: "alice.testnet",
    });
    expect(parseChatPayment("send 1 USDC to alice.near on mainnet", "testnet")).toHaveProperty("issue");
    expect(parseChatPayment("send 1 USDC to alice.testnet on testnet")).toHaveProperty("issue");
  });
  it("uses exact inverse price math for dip thresholds", () => {
    const rule = testnetRuleSchema.parse({
      name: "Dip",
      kind: "dip",
      assetId: USDC,
      outputAssetId: USDT,
      recipient: null,
      amount: "1",
      budget: "5",
      costBasis: null,
      intervalSeconds: 60,
      thresholdBps: 1000,
      expiresAt: Date.now() + 10000,
    });
    expect(priceTrigger(rule, 100n, 110n)).toBe(false);
    expect(priceTrigger(rule, 100n, 112n)).toBe(true);
  });
  it("requires the explicit acquisition basis before a profit threshold passes", () => {
    const rule = testnetRuleSchema.parse({
      name: "Profit",
      kind: "profit",
      assetId: USDC,
      outputAssetId: USDT,
      recipient: null,
      amount: "1",
      budget: "5",
      costBasis: "1",
      intervalSeconds: 60,
      thresholdBps: 500,
      expiresAt: Date.now() + 10000,
    });
    expect(priceTrigger(rule, 0n, 1049999n)).toBe(false);
    expect(priceTrigger(rule, 0n, 1050000n)).toBe(true);
    expect(priceTrigger({ ...rule, costBasis: null }, 0n, 99999999n)).toBe(false);
  });
});
