import { createSecretKey } from "node:crypto";
import { testDatabase } from "@tests/server/db/test-database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAgentSetup, fulfilSetupBudget, setupBindingHash } from "@/server/agents/setup-binding";
import { readWalletBudgets } from "@/server/agents/token-budgets";
import {
  createManualAgentSetup,
  deleteAgentSetup,
  readAgentSetup,
  updateAgentSetup,
} from "@/server/chat/agent-drafts";
import { chatCipher } from "@/server/chat/cipher";
import { agents } from "@/server/db/agent-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { walletTokenHolding, walletTokenHoldings } from "@/server/portfolio/wallet-tokens";
import { agentInstructionSchema } from "@/shared/agent-instructions";
import { DEFAULT_POLICY } from "@/shared/agents";

vi.mock("server-only", () => ({}));
vi.mock("@/server/portfolio/wallet-tokens", () => ({
  walletTokenHolding: vi.fn(),
  walletTokenHoldings: vi.fn(),
}));
const cipher = chatCipher(createSecretKey(Buffer.alloc(32, 27))),
  asset = "nep141:unpriced.near";
let context: Awaited<ReturnType<typeof testDatabase>>;
let agentId: string;
beforeEach(async () => {
  context = await testDatabase();
  agentId = crypto.randomUUID();
  const held = {
    assetId: asset,
    symbol: "TOKEN",
    decimals: 6,
    balanceUnits: "10000000",
    spendableUnits: "10000000",
    blockHeight: 1,
    observedAt: Date.now(),
  };
  vi.mocked(walletTokenHolding).mockResolvedValue(held);
  vi.mocked(walletTokenHoldings).mockResolvedValue({
    tokens: [held],
    complete: true,
    note: "Offline finalized balance",
  });
  await context.db.insert(agents).values({
    id: agentId,
    userId: "owner",
    name: "Budget agent",
    pack: "spot_trader",
    status: "paused",
    reason: "Offline",
    policyJson: JSON.stringify(DEFAULT_POLICY),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
});
afterEach(async () => context.postgres.close());
async function setup() {
  return createManualAgentSetup(
    context.db,
    "owner",
    crypto.randomUUID(),
    "spot_trader",
    ["Buy NEAR", "1 token", "Reviewed exits"],
    "",
    cipher,
    { assetId: asset, amount: "7" },
  );
}
function rule() {
  return agentInstructionSchema.parse({
    format: 2,
    kind: "spot_trader",
    side: "buy",
    payAssetId: asset,
    buyAssetId: "nep141:wrap.near",
    priceUnit: "quote_token",
    amountUnits: "1000000",
    entry: { type: "market" },
    exits: { takeProfitPrice: null, stopLossPrice: null, trailingStopBps: null },
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
}
describe("setup-to-agent exact-budget handoff", () => {
  it("binds one immutable reviewed setup and prevents independent edits or deletion", async () => {
    const draft = await setup();
    await userTransaction(context.db, "owner", (tx) =>
      bindAgentSetup(tx, "owner", agentId, draft.id, setupBindingHash(draft), rule(), cipher),
    );
    expect((await readAgentSetup(context.db, "owner", draft.id, cipher)).agentId).toBe(agentId);
    await expect(deleteAgentSetup(context.db, "owner", draft.id, cipher)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      updateAgentSetup(context.db, "owner", draft.id, "Different order", cipher),
    ).rejects.toMatchObject({ code: "conflict" });
    const other = crypto.randomUUID();
    await expect(
      userTransaction(context.db, "owner", (tx) =>
        bindAgentSetup(tx, "owner", other, draft.id, setupBindingHash(draft), rule(), cipher),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("releases only confirmed funding units from the wallet earmark and cannot hand off twice", async () => {
    const draft = await setup();
    await userTransaction(context.db, "owner", (tx) =>
      bindAgentSetup(tx, "owner", agentId, draft.id, setupBindingHash(draft), rule(), cipher),
    );
    await userTransaction(context.db, "owner", (tx) =>
      fulfilSetupBudget(tx, "owner", agentId, asset, "3000000", cipher),
    );
    const updated = await readAgentSetup(context.db, "owner", draft.id, cipher);
    expect(updated.budget).toMatchObject({ units: "7000000", walletReservedUnits: "4000000" });
    expect(
      (await readWalletBudgets(context.db, "owner", undefined, undefined, cipher)).tokens[0]?.allocatedUnits,
    ).toBe("4000000");
    await expect(
      userTransaction(context.db, "owner", (tx) =>
        fulfilSetupBudget(tx, "owner", agentId, asset, "5000000", cipher),
      ),
    ).rejects.toMatchObject({ code: "not_ready" });
    expect((await readAgentSetup(context.db, "owner", draft.id, cipher)).budget?.walletReservedUnits).toBe(
      "4000000",
    );
    await context.db.update(agents).set({ deletedAt: Date.now() }).where(eq(agents.id, agentId));
    await deleteAgentSetup(context.db, "owner", draft.id, cipher);
  });
});
