import { beforeEach, describe, expect, it, vi } from "vitest";
import { callViewFunction } from "@/server/near/rpc";
import { readPublicIntentsInventory } from "@/server/portfolio/public-intents";

vi.mock("server-only", () => ({}));
vi.mock("@/server/near/rpc", () => ({ callViewFunction: vi.fn() }));
const blockHash = "1".repeat(44);
beforeEach(() => vi.resetAllMocks());
describe("complete public Intents inventory", () => {
  it("discovers previously untracked tokens and pins all balance reads to the same block", async () => {
    vi.mocked(callViewFunction)
      .mockResolvedValueOnce({
        value: [{ token_id: "nep141:new-token.near" }, { token_id: "nep141:wrap.near" }],
        blockHeight: 7,
        blockHash,
      })
      .mockResolvedValueOnce({ value: ["123", "0"], blockHeight: 7, blockHash });
    expect(await readPublicIntentsInventory("owner.near")).toEqual({
      complete: true,
      blockHeight: 7,
      balances: [{ assetId: "nep141:new-token.near", quantity: 123n }],
    });
    expect(callViewFunction).toHaveBeenLastCalledWith(
      "intents.near",
      "mt_batch_balance_of",
      { account_id: "owner.near", token_ids: ["nep141:new-token.near", "nep141:wrap.near"] },
      undefined,
      blockHash,
    );
  });
  it("rejects a mixed-block response instead of reporting a complete balance", async () => {
    vi.mocked(callViewFunction)
      .mockResolvedValueOnce({ value: [{ token_id: "nep141:token.near" }], blockHeight: 7, blockHash })
      .mockResolvedValueOnce({ value: ["1"], blockHeight: 8, blockHash });
    await expect(readPublicIntentsInventory("owner.near")).rejects.toThrow("enumerated block");
  });
  it("distinguishes an empty verified account from unavailable enumeration", async () => {
    vi.mocked(callViewFunction).mockResolvedValueOnce({ value: [], blockHeight: 7, blockHash });
    expect((await readPublicIntentsInventory("owner.near")).complete).toBe(true);
    vi.mocked(callViewFunction).mockRejectedValueOnce(new Error("Offline RPC unavailable"));
    await expect(readPublicIntentsInventory("owner.near")).rejects.toThrow("unavailable");
  });
});
