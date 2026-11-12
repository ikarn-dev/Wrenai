import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/testnet/provider", () => ({
  VERIFIER: "verifier.tidepool-sandbox.testnet",
  verifierReady: vi.fn(async () => undefined),
}));
vi.mock("@/server/testnet/rpc", () => ({ testnetView: vi.fn(), testnetBalance: vi.fn(async () => 9n) }));

import { locatedBalance, publicIntentsBalances, publicIntentsTransfer } from "@/server/testnet/intents";
import { VERIFIER, verifierReady } from "@/server/testnet/provider";
import { testnetView } from "@/server/testnet/rpc";
import { USDC } from "./context";

afterEach(() => vi.clearAllMocks());
describe("public testnet verifier balances", () => {
  it("reads all six exact asset IDs without authentication or mislabeling them private", async () => {
    vi.mocked(testnetView).mockResolvedValue([
      "100000000",
      "100000000",
      "40000000000000000000000000",
      "100000",
      "30000000000000000",
      "30000",
    ]);
    const result = await publicIntentsBalances("alice.testnet");
    expect(result.get(USDC)).toBe(100000000n);
    expect(result.get("native:near")).toBeUndefined();
    expect(result.size).toBe(6);
    expect(verifierReady).toHaveBeenCalled();
  });
  it("rejects partial or invalid observations instead of inventing zero balances", async () => {
    vi.mocked(testnetView).mockResolvedValue(["100000000"]);
    await expect(publicIntentsBalances("alice.testnet")).rejects.toThrow();
    vi.mocked(testnetView).mockRejectedValue(new Error("offline"));
    await expect(publicIntentsBalances("alice.testnet")).rejects.toThrow("offline");
  });
  it("keeps native NEAR wallet-only", async () => {
    await expect(locatedBalance("alice.testnet", "native:near", "intents")).rejects.toThrow("Native NEAR");
    await expect(locatedBalance("alice.testnet", "native:near", "wallet")).resolves.toBe(9n);
  });
  it("creates an exact owner-authorized NEP-245 call, with no off-chain signing key", async () => {
    vi.mocked(testnetView).mockResolvedValue(true);
    expect(await publicIntentsTransfer("alice.testnet", USDC, "1000000", "deposit.testnet")).toEqual({
      receiverId: VERIFIER,
      method: "mt_transfer",
      args: { receiver_id: "deposit.testnet", token_id: USDC, amount: "1000000" },
      deposit: "1",
      gas: "50000000000000",
    });
    expect(testnetView).toHaveBeenCalledWith(VERIFIER, "is_auth_by_predecessor_id_enabled", {
      account_id: "alice.testnet",
    });
  });
  it("does not override disabled predecessor authorization or send to itself", async () => {
    vi.mocked(testnetView).mockResolvedValue(false);
    await expect(publicIntentsTransfer("alice.testnet", USDC, "1", "deposit.testnet")).rejects.toThrow(
      "disabled",
    );
    await expect(publicIntentsTransfer("alice.testnet", USDC, "1", "alice.testnet")).rejects.toThrow(
      "different recipient",
    );
  });
});
