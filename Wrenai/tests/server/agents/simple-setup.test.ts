import { createSecretKey } from "node:crypto";
import { testDatabase } from "@tests/server/db/test-database";
import { fundingAsset, fundingInstruction, strategyReceipt } from "@tests/server/funding/context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandAgent } from "@/server/agents/mutations";
import { setupBindingHash } from "@/server/agents/setup-binding";
import { saveAgentWithBudget } from "@/server/agents/simple-setup";
import { readWalletBudgets } from "@/server/agents/token-budgets";
import { chatCipher } from "@/server/chat/cipher";
import { agents, strategyDrafts, strategyVersions } from "@/server/db/agent-schema";
import { chatAgentDrafts } from "@/server/db/chat-schema";
import { resolvedTradeAssets } from "@/server/execution/asset-review";
import { walletTokenHolding, walletTokenHoldings } from "@/server/portfolio/wallet-tokens";
import { DEFAULT_POLICY, strategySchema } from "@/shared/agents";
import { agentSetupDraftSchema } from "@/shared/research";

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)) }),
}));
vi.mock("@/server/portfolio/wallet-tokens", () => ({
  walletTokenHolding: vi.fn(),
  walletTokenHoldings: vi.fn(),
}));
let context: Awaited<ReturnType<typeof testDatabase>>;
const tokens = [
  { assetId: fundingAsset, symbol: "USDC", decimals: 6, blockchain: "near" },
  { assetId: "nep141:wrap.near", symbol: "NEAR", decimals: 24, blockchain: "near" },
];
beforeEach(async () => {
  context = await testDatabase();
  const holding = {
    assetId: fundingAsset,
    symbol: "USDC",
    decimals: 6,
    balanceUnits: "10000000",
    spendableUnits: "10000000",
    observedAt: Date.now(),
    blockHeight: 1,
  };
  vi.mocked(walletTokenHolding).mockResolvedValue(holding);
  vi.mocked(walletTokenHoldings).mockResolvedValue({
    tokens: [holding],
    note: "Offline wallet",
    complete: true,
  });
});
afterEach(async () => context.postgres.close());
async function input() {
  const id = crypto.randomUUID(),
    now = Date.now();
  await context.db.insert(strategyDrafts).values({
    id,
    userId: "owner",
    requestId: crypto.randomUUID(),
    pack: "spot_trader",
    strategyText: "Buy one wNEAR with this exact USDC budget.",
    configJson: JSON.stringify(fundingInstruction()),
    attestationJson: JSON.stringify(strategyReceipt()),
    createdAt: now,
    expiresAt: now + 60000,
  });
  return {
    requestId: crypto.randomUUID(),
    draftId: id,
    agentId: null,
    expectedRevision: null,
    policy: DEFAULT_POLICY,
    budget: { assetId: fundingAsset, amount: "5" },
  };
}
describe("one reviewed agent setup", () => {
  it("commits the paused agent, exact token reservation and canonical bindings together and recovers retries", async () => {
    const request = await input(),
      id = await saveAgentWithBudget(context.db, "owner", request, tokens);
    expect(await saveAgentWithBudget(context.db, "owner", request, tokens)).toBe(id);
    expect(await context.db.select().from(agents)).toHaveLength(1);
    const [version] = await context.db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.agentId, id));
    expect(
      resolvedTradeAssets(
        strategySchema.parse(JSON.parse(version?.configJson ?? "null")),
        version?.resolvedAssetsJson ?? null,
        tokens,
      ).map((asset) => asset.assetId),
    ).toEqual([fundingAsset, "nep141:wrap.near"]);
    expect((await readWalletBudgets(context.db, "owner")).tokens[0]?.allocatedUnits).toBe("5000000");
  });
  it("rolls back the wallet earmark when saving has expired or exact assets are unsupported", async () => {
    const request = await input();
    await context.db
      .update(strategyDrafts)
      .set({ expiresAt: 1 })
      .where(eq(strategyDrafts.id, request.draftId));
    await expect(saveAgentWithBudget(context.db, "owner", request, tokens)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await context.db.select().from(chatAgentDrafts)).toHaveLength(0);
    const unsupported = await input();
    await expect(saveAgentWithBudget(context.db, "owner", unsupported, [])).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(await context.db.select().from(agents)).toHaveLength(0);
    expect(await context.db.select().from(chatAgentDrafts)).toHaveLength(0);
  });
  it("does not reuse another owner's draft or allow the same wallet units into competing agents", async () => {
    const request = await input();
    await expect(saveAgentWithBudget(context.db, "stranger", request, tokens)).rejects.toMatchObject({
      code: "not_found",
    });
    await saveAgentWithBudget(
      context.db,
      "owner",
      { ...request, budget: { ...request.budget, amount: "7" } },
      tokens,
    );
    await expect(saveAgentWithBudget(context.db, "owner", await input(), tokens)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(await context.db.select().from(agents)).toHaveLength(1);
  });
  it("links a chat setup through the same review and releases an unfunded reservation when deleted", async () => {
    const request = await input(),
      setup = agentSetupDraftSchema.parse({
        id: crypto.randomUUID(),
        tool: "spot_trader",
        brief: "Buy NEAR after reviewing this chat setup.",
        reports: [],
        createdAt: Date.now(),
      }),
      cipher = chatCipher();
    await context.db.insert(chatAgentDrafts).values({
      id: setup.id,
      userId: "owner",
      sourceType: "chat",
      conversationId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      tool: setup.tool,
      sealedDraft: cipher.seal("owner", setup.id, "agent-setup", JSON.stringify(setup)),
      createdAt: setup.createdAt,
    });
    const id = await saveAgentWithBudget(
      context.db,
      "owner",
      { ...request, setupId: setup.id, setupHash: setupBindingHash(setup) },
      tokens,
    );
    expect(await context.db.select().from(chatAgentDrafts)).toHaveLength(1);
    expect((await readWalletBudgets(context.db, "owner")).tokens[0]?.allocatedUnits).toBe("5000000");
    await commandAgent(context.db, "owner", {
      requestId: crypto.randomUUID(),
      agentId: id,
      expectedRevision: 1,
      command: "delete",
    });
    expect((await readWalletBudgets(context.db, "owner")).tokens[0]?.allocatedUnits).toBe("0");
    expect(await context.db.select().from(chatAgentDrafts)).toHaveLength(1);
  });
});
