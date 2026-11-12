import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { testnetBalance, testnetRpc, testnetView, transferCalls } from "@/server/testnet/rpc";
import { configureTestnet, USDC } from "./context";

function reply(result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: "wrenai-testnet", result });
}
function contractReply(value: unknown): Response {
  return reply({ result: [...Buffer.from(JSON.stringify(value))], block_height: 277218351 });
}
function rpcFailure(cause: string): Response {
  return Response.json({ error: { name: "HANDLER_ERROR", cause: { name: cause }, message: "Server error" } });
}
beforeEach(configureTestnet);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("actual lossless testnet RPC decoding", () => {
  it("decodes real RPC byte arrays and preserves token balances beyond Number precision", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(contractReply({ decimals: 6 }))
      .mockResolvedValueOnce(contractReply("9007199254740993123456789"));
    vi.stubGlobal("fetch", fetcher);
    expect(await testnetBalance("alice.testnet", USDC)).toBe(9007199254740993123456789n);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("preserves a numeric nonce larger than Number precision", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"result":{"nonce":9007199254740993}}')),
    );
    expect(await testnetRpc("query", {})).toEqual({ nonce: "9007199254740993" });
  });
  it("treats finalized UNKNOWN_ACCOUNT as zero native balance without querying protocol config", async () => {
    const fetcher = vi.fn(async () => rpcFailure("UNKNOWN_ACCOUNT"));
    vi.stubGlobal("fetch", fetcher);
    expect(await testnetBalance("fresh.testnet", "native:near")).toBe(0n);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never turns an RPC outage or a missing token contract into a zero balance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    await expect(testnetBalance("alice.testnet", "native:near")).rejects.toMatchObject({
      code: "unavailable",
      rpcCause: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rpcFailure("UNKNOWN_ACCOUNT")),
    );
    await expect(testnetBalance("alice.testnet", USDC)).rejects.toMatchObject({
      rpcCause: "UNKNOWN_ACCOUNT",
    });
  });
  it("keeps native storage deductions exact with losslessly parsed storage_usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          reply({ amount: "1000000000000000000000000", locked: "0", storage_usage: 128 }),
        )
        .mockResolvedValueOnce(
          reply({ chain_id: "testnet", runtime_config: { storage_amount_per_byte: "10000000000000000000" } }),
        ),
    );
    expect(await testnetBalance("alice.testnet", "native:near")).toBe(998720000000000000000000n);
  });
  it("does not classify contract panics or malformed return bytes as user input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ error: "contract panic" })),
    );
    await expect(testnetView("token.testnet", "ft_metadata", {})).rejects.toMatchObject({
      code: "unavailable",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ result: [256] })),
    );
    await expect(testnetView("token.testnet", "ft_metadata", {})).rejects.toMatchObject({
      rpcCause: "INVALID_CONTRACT_RESULT",
    });
  });
  it("keeps ambiguous transaction status explicit and makes no repeat submission", async () => {
    const fetcher = vi.fn(async () => rpcFailure("UNKNOWN_TRANSACTION"));
    vi.stubGlobal("fetch", fetcher);
    await expect(testnetRpc("tx", {})).rejects.toThrow("Check its status before sending again");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("allows native activation of an exact implicit recipient but rejects nonexistent named recipients", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rpcFailure("UNKNOWN_ACCOUNT")),
    );
    const recipient = "a".repeat(64);
    await expect(transferCalls("native:near", "100", recipient)).resolves.toEqual([
      { receiverId: recipient, method: null, args: {}, deposit: "100", gas: "0" },
    ]);
    await expect(transferCalls("native:near", "100", "missing.testnet")).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
