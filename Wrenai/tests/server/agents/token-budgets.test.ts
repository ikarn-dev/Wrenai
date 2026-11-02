import { createSecretKey } from "node:crypto";
import { testDatabase } from "@tests/server/db/test-database";
import { executionTestContext, fundTestAgent, observeInventory } from "@tests/server/execution/test-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWalletBudgets } from "@/server/agents/token-budgets";
import {
  createManualAgentSetup,
  deleteAgentSetup,
  readAgentSetup,
  updateAgentSetup,
} from "@/server/chat/agent-drafts";
import { chatCipher } from "@/server/chat/cipher";
import { walletTokenHolding, walletTokenHoldings } from "@/server/portfolio/wallet-tokens";
import type { AgentBudgetInput, WalletHolding } from "@/shared/agent-budget";

vi.mock("server-only", () => ({}));
vi.mock("@/server/portfolio/wallet-tokens", () => ({
  walletTokenHolding: vi.fn(),
  walletTokenHoldings: vi.fn(),
}));
const cipher = chatCipher(createSecretKey(Buffer.alloc(32, 52)));
const asset = "nep141:unpriced.near";
let store: Awaited<ReturnType<typeof testDatabase>>;
function holding(assetId = asset): WalletHolding {
  return {
    assetId,
    symbol: "TOKEN",
    decimals: 6,
    balanceUnits: "10000000",
    spendableUnits: "10000000",
    observedAt: Date.now(),
    blockHeight: 100,
  };
}
async function create(amount: string, id = crypto.randomUUID(), assetId = asset) {
  return createManualAgentSetup(store.db, "owner", id, "spot_trader", ["Buy", "1", "Limits"], "", cipher, {
    assetId,
    amount,
  });
}
beforeEach(async () => {
  store = await testDatabase();
  vi.mocked(walletTokenHolding)
    .mockReset()
    .mockImplementation(async (_account, id) => holding(id));
  vi.mocked(walletTokenHoldings)
    .mockReset()
    .mockResolvedValue({ tokens: [holding()], note: "Finalized offline holdings" });
});
afterEach(async () => {
  vi.useRealTimers();
  await store.postgres.close();
});
describe("owner-serialized token reservations", () => {
  it("prevents concurrent over-allocation and retries the successful request without another balance read", async () => {
    const results = await Promise.allSettled([create("7"), create("7")]);
    const successful = results.filter((result) => result.status === "fulfilled");
    expect(successful).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const result = successful[0];
    if (result?.status !== "fulfilled") {
      throw new Error("Expected a saved budget");
    }
    const draft = result.value;
    vi.mocked(walletTokenHolding).mockClear().mockRejectedValue(new Error("RPC outage"));
    expect((await create("7.000000", draft.id)).budget?.units).toBe("7000000");
    expect(walletTokenHolding).not.toHaveBeenCalled();
    await expect(create("8", draft.id)).rejects.toMatchObject({ code: "conflict" });
    expect(
      (await readWalletBudgets(store.db, "owner", undefined, undefined, cipher)).tokens[0],
    ).toMatchObject({ allocatedUnits: "7000000", availableUnits: "3000000" });
  });
  it("edits by excluding its own reservation, resets review, and releases only discarded setup funds", async () => {
    const first = await create("7");
    await create("3");
    await updateAgentSetup(store.db, "owner", first.id, first.brief, cipher, true, {
      assetId: asset,
      amount: "6",
    });
    expect((await readAgentSetup(store.db, "owner", first.id, cipher)).budget?.units).toBe("6000000");
    await expect(create("2")).rejects.toMatchObject({ code: "invalid_input" });
    await updateAgentSetup(store.db, "owner", first.id, "Changed conditions", cipher, false, null);
    expect((await readAgentSetup(store.db, "owner", first.id, cipher)).budget).toBeUndefined();
    expect((await readAgentSetup(store.db, "owner", first.id, cipher)).reviewState).toBe("draft");
    const next = await create("7");
    await deleteAgentSetup(store.db, "owner", next.id, cipher);
    expect((await create("7")).budget?.units).toBe("7000000");
  });
  it("separates exact token identities, verifies ownership before contract reads and rechecks stale balances", async () => {
    const first = await create("10");
    expect((await create("10", crypto.randomUUID(), "nep141:other.near")).budget?.assetId).toBe(
      "nep141:other.near",
    );
    vi.mocked(walletTokenHolding).mockClear();
    await expect(
      updateAgentSetup(store.db, "stranger", first.id, first.brief, cipher, false, {
        assetId: asset,
        amount: "1",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(walletTokenHolding).not.toHaveBeenCalled();
    vi.mocked(walletTokenHolding).mockResolvedValue({ ...holding(), observedAt: Date.now() - 15_000 });
    await expect(create("1", crypto.randomUUID(), "nep141:third.near")).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
  it("reports externally spent funds, retains reservations and permits reductions without inventing funds", async () => {
    const first = await create("7");
    const small = { ...holding(), balanceUnits: "2000000", spendableUnits: "2000000" };
    vi.mocked(walletTokenHolding).mockResolvedValue(small);
    vi.mocked(walletTokenHoldings).mockResolvedValue({ tokens: [small], note: "Reduced wallet" });
    expect(
      (await readWalletBudgets(store.db, "owner", undefined, undefined, cipher)).tokens[0],
    ).toMatchObject({ availableUnits: "0", deficitUnits: "5000000" });
    await expect(create("1")).rejects.toMatchObject({ code: "invalid_input" });
    await updateAgentSetup(store.db, "owner", first.id, first.brief, cipher, false, {
      assetId: asset,
      amount: "6",
    });
    expect((await readAgentSetup(store.db, "owner", first.id, cipher)).budget?.units).toBe("6000000");
  });
  it("does not accept balances, denominations or wallet identity supplied by the browser", async () => {
    const input: AgentBudgetInput = { assetId: asset, amount: "1.0000001" };
    await expect(
      createManualAgentSetup(
        store.db,
        "owner",
        crypto.randomUUID(),
        "dca",
        ["Buy", "Daily", "Limits"],
        "",
        cipher,
        input,
      ),
    ).rejects.toThrow();
    expect((await store.postgres.query("SELECT id FROM chat_agent_drafts")).rows).toHaveLength(0);
  });
  it("does not subtract already moved venue funds from the connected wallet a second time", async () => {
    const context = await executionTestContext();
    try {
      await observeInventory(context.db, "confidential", "5000000");
      await fundTestAgent(context.db, context.agentId, "5000000", "5000000");
      const input = { assetId: "nep141:usdc.test-fixture.near", amount: "7" };
      const draft = await createManualAgentSetup(
        context.db,
        "owner",
        crypto.randomUUID(),
        "dca",
        ["Buy", "Daily", "Limits"],
        "",
        cipher,
        input,
      );
      vi.mocked(walletTokenHoldings).mockResolvedValue({
        tokens: [holding(input.assetId)],
        note: "Separate wallet balance",
      });
      const view = await readWalletBudgets(context.db, "owner", undefined, undefined, cipher);
      expect(draft.budget?.units).toBe("7000000");
      expect(view.funded).toEqual([{ scope: "confidential", assetId: input.assetId, units: "5000000" }]);
      expect(view.tokens[0]?.availableUnits).toBe("3000000");
    } finally {
      await context.postgres.close();
    }
  });
});
