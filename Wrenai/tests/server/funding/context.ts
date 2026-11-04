import { testDatabase } from "@tests/server/db/test-database";
import { chatCipher } from "@/server/chat/cipher";
import { agents, strategyVersions } from "@/server/db/agent-schema";
import { chatAgentDrafts } from "@/server/db/chat-schema";
import type { AppDatabase } from "@/server/db/client";
import { delegatedKeys } from "@/server/db/schema";
import { generateAgentKey } from "@/server/delegation/agent-key";
import { agentInstructionSchema } from "@/shared/agent-instructions";
import { DEFAULT_POLICY } from "@/shared/agents";
import { agentSetupDraftSchema } from "@/shared/research";
import { walletFundingSnapshotSchema } from "@/shared/wallet-funding";

export const fundingAsset = "nep141:usdc.test-fixture.near";
export function fundingInstruction() {
  return agentInstructionSchema.parse({
    format: 2,
    kind: "spot_trader",
    side: "buy",
    payAssetId: fundingAsset,
    buyAssetId: "nep141:wrap.near",
    priceUnit: "usd",
    amountUnits: "1000000",
    entry: { type: "market" },
    exits: { takeProfitPrice: null, stopLossPrice: null, trailingStopBps: null },
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
}
export function fundingSnapshot(id = crypto.randomUUID()) {
  return walletFundingSnapshotSchema.parse({
    fundingId: id,
    accountId: "owner.near",
    walletAssetId: fundingAsset,
    assetId: fundingAsset,
    symbol: "USDC",
    decimals: 6,
    units: "5000000",
    minimumPrivateUnits: "4975000",
    principalMicroUsd: "5000000",
    maximumSlippageBps: 50,
    maximumProviderFeeBps: 0,
  });
}
export function strategyReceipt() {
  return {
    model: "Qwen/Qwen3.8-27B",
    completionId: "offline-review",
    signatureKind: "provider_tee",
    verifiedAt: Date.now(),
    requestHash: "a".repeat(64),
    responseHash: "b".repeat(64),
    evidenceHash: "c".repeat(64),
    evidenceJson: "{}",
  };
}
export async function createFundingAgent(db: AppDatabase, owner = "owner"): Promise<string> {
  const agentId = crypto.randomUUID(),
    now = Date.now();
  await db.insert(agents).values({
    id: agentId,
    userId: owner,
    name: `Funding ${agentId}`,
    pack: "spot_trader",
    status: "paused",
    reason: "Offline",
    policyJson: JSON.stringify({ ...DEFAULT_POLICY, cooldownSeconds: 0 }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(strategyVersions).values({
    id: crypto.randomUUID(),
    agentId,
    version: 1,
    strategyText: "Buy NEAR with one USDC per order.",
    configJson: JSON.stringify(fundingInstruction()),
    attestationJson: JSON.stringify(strategyReceipt()),
    createdAt: now,
  });
  const setupId = crypto.randomUUID(),
    cipher = chatCipher(),
    draft = agentSetupDraftSchema.parse({
      id: setupId,
      tool: "spot_trader",
      brief: "Buy NEAR with one USDC per order.",
      agentId,
      reports: [],
      createdAt: now,
      reviewState: "reviewed",
      budget: {
        source: "near_wallet",
        accountId: `${owner}.near`,
        assetId: fundingAsset,
        symbol: "USDC",
        decimals: 6,
        units: "5000000",
        observedAt: now,
        blockHeight: 1,
      },
    });
  await db.insert(chatAgentDrafts).values({
    id: setupId,
    userId: owner,
    sourceType: "manual",
    conversationId: null,
    turnId: null,
    tool: "spot_trader",
    sealedDraft: cipher.seal(owner, setupId, "agent-setup", JSON.stringify(draft)),
    createdAt: now,
  });
  return agentId;
}
export async function fundingTestContext() {
  const context = await testDatabase(),
    agentId = await createFundingAgent(context.db);
  const key = generateAgentKey();
  await context.db
    .insert(delegatedKeys)
    .values({ userId: "owner", ...key, createdAt: Date.now(), activatedAt: Date.now(), activatedAtBlock: 1 });
  return { ...context, agentId };
}
