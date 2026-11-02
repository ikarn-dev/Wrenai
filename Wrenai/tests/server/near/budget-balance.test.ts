import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { viewNearBudgetBalance } from "@/server/near/rpc";

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({ serverEnv: () => ({ nearRpcUrl: "https://offline.test" }) }));
afterEach(() => vi.unstubAllGlobals());
function responses(amount: bigint, locked = 0n, price = 10n ** 19n): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = z.object({ method: z.string() }).parse(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          result:
            body.method === "EXPERIMENTAL_protocol_config"
              ? {
                  chain_id: "mainnet",
                  runtime_config: { storage_amount_per_byte: price.toString() },
                }
              : {
                  amount: amount.toString(),
                  locked: locked.toString(),
                  storage_usage: 2000,
                  block_height: 100,
                },
        }),
      );
    }),
  );
}
describe("native budget headroom", () => {
  it("keeps protocol storage and 0.05 NEAR for gas without using floating point", async () => {
    responses(10n ** 24n);
    expect(await viewNearBudgetBalance("owner.near")).toEqual({
      balance: 10n ** 24n,
      spendable: 93n * 10n ** 22n,
      blockHeight: 100,
    });
  });
  it("uses current storage pricing and never turns locked stake into a liquid budget", async () => {
    responses(2n * 10n ** 24n, 10n ** 24n);
    expect((await viewNearBudgetBalance("owner.near")).spendable).toBe(195n * 10n ** 22n);
    responses(10n ** 24n, 0n, 10n ** 20n);
    expect((await viewNearBudgetBalance("owner.near")).spendable).toBe(75n * 10n ** 22n);
    responses(1n);
    expect((await viewNearBudgetBalance("owner.near")).spendable).toBe(0n);
  });
  it("fails closed if current protocol storage data is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "Unavailable" } }))),
    );
    await expect(viewNearBudgetBalance("owner.near")).rejects.toThrow();
  });
});
