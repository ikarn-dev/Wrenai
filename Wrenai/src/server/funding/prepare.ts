import "server-only";
import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { agentSummary, killSwitchEngaged, ownedAgent } from "@/server/agents/records";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import { walletFundings } from "@/server/db/funding-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { readDelegatedKey } from "@/server/delegation/delegated-key";
import { ExecutionError } from "@/server/execution/contracts";
import { dryQuoteRequest, oneClickJson, verifiedDryQuote } from "@/server/execution/oneclick-quote";
import { databaseTime, executionHash } from "@/server/execution/records";
import { walletTokenHolding } from "@/server/portfolio/wallet-tokens";
import { intentTokens } from "@/server/research/intents";
import { instructionFundingAsset, usesNativeNearPayout } from "@/shared/agent-instructions";
import { parseUsd, policySchema } from "@/shared/agents";
import { type WalletFundingView, walletFundingSnapshotSchema } from "@/shared/wallet-funding";
import { linkedAgentBudget, walletFundingView } from "./records";

export const prepareWalletFundingSchema = z.strictObject({
  requestId: z.uuid(),
  agentId: z.uuid(),
  expectedRevision: z.number().int().positive(),
});

export async function prepareWalletFunding(
  db: AppDatabase,
  user: SessionUser,
  raw: unknown,
): Promise<WalletFundingView> {
  const input = prepareWalletFundingSchema.parse(raw),
    inputHash = executionHash(input);
  const agent = await ownedAgent(db, user.id, input.agentId);
  if (agent.pack === "whale_tracker" || (await killSwitchEngaged(db, user.id))) {
    throw new ExecutionError(
      "not_ready",
      "Funding is unavailable for this agent while its execution is blocked.",
    );
  }
  const [existing] = await db
    .select()
    .from(walletFundings)
    .where(
      and(
        eq(walletFundings.userId, user.id),
        eq(walletFundings.agentId, agent.id),
        ne(walletFundings.state, "complete"),
      ),
    )
    .limit(1);
  if (existing) {
    return walletFundingView(existing);
  }
  if (agent.status === "running" || agent.revision !== input.expectedRevision) {
    throw new ExecutionError("conflict", "Pause the agent and refresh its funding review.");
  }
  const setup = await linkedAgentBudget(db, user.id, agent.id),
    budget = setup.budget;
  if (
    !budget ||
    budget.accountId !== user.accountId ||
    BigInt(budget.walletReservedUnits ?? budget.units) <= 0n
  ) {
    throw new ExecutionError("not_ready", "No unfunded token budget remains for this agent.");
  }
  const policy = policySchema.parse(JSON.parse(agent.policyJson)),
    registry = await intentTokens();
  const assetId = budget.assetId === "native:near" ? "nep141:wrap.near" : budget.assetId;
  const summary = await agentSummary(db, agent);
  if ("format" in summary.strategy && usesNativeNearPayout(summary.strategy)) {
    throw new ExecutionError("not_ready", "Fund this agent's public RHEA trading balance.");
  }
  if (!("format" in summary.strategy) || instructionFundingAsset(summary.strategy) !== assetId) {
    throw new ExecutionError(
      "conflict",
      "The selected wallet token differs from the agent’s reviewed spending token.",
    );
  }
  const token = registry.tokens.find((token) => token.assetId === assetId);
  const holding = await walletTokenHolding(user.accountId, budget.assetId),
    key = await readDelegatedKey(user);
  const units = budget.walletReservedUnits ?? budget.units;
  if (
    !token ||
    token.decimals !== budget.decimals ||
    holding.decimals !== budget.decimals ||
    BigInt(holding.spendableUnits) < BigInt(units)
  ) {
    throw new ExecutionError(
      "not_ready",
      "The selected token route or wallet balance changed. Refresh the agent budget.",
    );
  }
  if (!key.checked || key.state.kind !== "active") {
    throw new ExecutionError(
      "not_ready",
      "Authorize the shared agent key before funding. It is reused by your agents.",
    );
  }
  const request = {
    ...dryQuoteRequest(user.accountId, assetId, assetId, units, policy.maxSlippageBps, "intents", Date.now()),
    recipientType: QuoteRequest.recipientType.CONFIDENTIAL_INTENTS,
  };
  const quote = verifiedDryQuote(
    await oneClickJson("/v0/quote", request),
    request,
    "intents",
    Date.now(),
    policy.maxSlippageBps,
  );
  const minimum =
    (BigInt(units) * BigInt(10000 - policy.maxSlippageBps - policy.maxProviderFeeBps) + 9999n) / 10000n;
  if (
    quote.appFeeBps > policy.maxProviderFeeBps ||
    BigInt(quote.minOutputUnits) < minimum ||
    BigInt(quote.inputMicroUsd ?? "0") <= 0n ||
    BigInt(quote.inputMicroUsd ?? "0") > parseUsd(policy.budgetUsd)
  ) {
    throw new ExecutionError(
      "limit",
      "Funding exceeds the reviewed fee or capital limit. Adjust the agent’s limits before depositing.",
    );
  }
  const snapshot = walletFundingSnapshotSchema.parse({
    fundingId: input.requestId,
    accountId: user.accountId,
    walletAssetId: budget.assetId,
    assetId,
    symbol: token.symbol,
    decimals: token.decimals,
    units,
    minimumPrivateUnits: minimum.toString(),
    principalMicroUsd: quote.inputMicroUsd,
    maximumSlippageBps: policy.maxSlippageBps,
    maximumProviderFeeBps: policy.maxProviderFeeBps,
  });
  return userTransaction(db, user.id, async (tx) => {
    const current = await ownedAgent(tx, user.id, agent.id),
      latest = await linkedAgentBudget(tx, user.id, agent.id),
      now = await databaseTime(tx);
    const [pending] = await tx
      .select()
      .from(walletFundings)
      .where(
        and(
          eq(walletFundings.userId, user.id),
          eq(walletFundings.agentId, agent.id),
          ne(walletFundings.state, "complete"),
        ),
      )
      .limit(1);
    if (pending) {
      return walletFundingView(pending);
    }
    if (
      current.revision !== input.expectedRevision ||
      executionHash(latest) !== executionHash(setup) ||
      now >= quote.expiresAt
    ) {
      throw new ExecutionError("conflict", "The funding review changed. Refresh before continuing.");
    }
    const [row] = await tx
      .insert(walletFundings)
      .values({
        id: input.requestId,
        userId: user.id,
        agentId: agent.id,
        strategyVersion: agent.version,
        inputHash,
        snapshotJson: JSON.stringify(snapshot),
        state: "prepared",
        createdAt: now,
        expiresAt: now + 300000,
        updatedAt: now,
      })
      .returning();
    if (!row) {
      throw new Error("The wallet funding review was not saved.");
    }
    return walletFundingView(row);
  });
}
