import { verifyTypedData, Wallet } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { signHlTransfer } from "@/server/execution/hyperliquid/signing";
import { tradingResponseJson } from "@/server/execution/trading-http";
import { hlUsdSendSchema } from "@/shared/perps-return";

vi.mock("server-only", () => ({}));
describe("Hyperliquid user-signed USDC transfers", () => {
  it("uses the documented transfer domain and binds the exact destination, amount, mainnet and nonce", () => {
    const wallet = new Wallet("0x0123456789012345678901234567890123456789012345678901234567890123");
    const action = hlUsdSendSchema.parse({
      type: "usdSend",
      hyperliquidChain: "Mainnet",
      signatureChainId: "0x66eee",
      destination: "0x2222222222222222222222222222222222222222",
      amount: "10.000001",
      time: 1690393044548,
    });
    const signature = signHlTransfer(wallet, action);
    const domain = {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 421614,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    };
    const types = {
      "HyperliquidTransaction:UsdSend": [
        { name: "hyperliquidChain", type: "string" },
        { name: "destination", type: "string" },
        { name: "amount", type: "string" },
        { name: "time", type: "uint64" },
      ],
    };
    expect(verifyTypedData(domain, types, action, signature)).toBe(wallet.address);
    expect(verifyTypedData(domain, types, { ...action, amount: "10.000002" }, signature)).not.toBe(
      wallet.address,
    );
    expect(hlUsdSendSchema.safeParse({ ...action, hyperliquidChain: "Testnet" }).success).toBe(false);
    expect(hlUsdSendSchema.safeParse({ ...action, expiresAfter: 100 }).success).toBe(false);
  });
  it("preserves numeric money exactly before parsing ledger transfers", async () => {
    const raw = '{"usdc":9007199254740993.000001,"fee":1,"time":1690393044548}';
    expect(await tradingResponseJson(new Response(raw), 1024, true)).toEqual({
      usdc: "9007199254740993.000001",
      fee: "1",
      time: "1690393044548",
    });
    await expect(tradingResponseJson(new Response(raw), 10, true)).rejects.toThrow("size limit");
  });
});
