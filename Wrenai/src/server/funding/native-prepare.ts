import "server-only";
import { z } from "zod";
import { ownedAgent } from "@/server/agents/records";
import { reservedWalletBudgets } from "@/server/agents/token-budgets";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import { nativeDeposits } from "@/server/db/native-funding-schema";
import { userTransaction } from "@/server/db/user-transaction";
import {
  currentAgentStrategy,
  instructionRouteTokens,
  resolvedTradeAssets,
} from "@/server/execution/asset-review";
import { ExecutionError } from "@/server/execution/contracts";
import { databaseTime, executionHash } from "@/server/execution/records";
import { quoteRhea } from "@/server/execution/rhea/quote";
import { manualSubject } from "@/server/manual-trading/subject";
import { callViewFunction } from "@/server/near/rpc";
import { walletTokenHolding } from "@/server/portfolio/wallet-tokens";
import { committedCapital } from "@/server/positions/capital-records";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { budgetFundingAsset } from "@/shared/agent-budget";
import { instructionFundingAsset, publicRoutePool, usesPublicRoute } from "@/shared/agent-instructions";
import { parseUsd, policySchema } from "@/shared/agents";
import {
  NATIVE_FUNDING_GAS,
  type NativeFundingView,
  nativeFundingRequestSchema,
  nativeFundingSnapshotSchema,
} from "@/shared/native-funding";
import { parseTokenAmount, positiveTokenUnitsSchema } from "@/shared/token-units";
import { activeNativeFunding, nativeFundingView } from "./native-records";
import { linkedAgentBudget } from "./records";

/**
 * The principal of funding a public-route agent, valued by quoting its spending token against the reviewed pair
 * on the reviewed pool. Null for agents without a public route, which value funding at proof time instead.
 */
async function publicFundingQuote(
  db: AppDatabase,
  userId: string,
  agentId: string,
  sourceAssetId: string,
  units: bigint,
): Promise<{ readonly revision: number; readonly quote: Awaited<ReturnType<typeof quoteRhea>> } | null> {
  const agent = await ownedAgent(db, userId, agentId);
  const current = await currentAgentStrategy(db, userId, agentId, agent.revision);
  const strategy = current.strategy;
  const pool = "format" in strategy ? publicRoutePool(strategy) : null;
  if (!("format" in strategy) || !pool) {
    return null;
  }
  const funding = instructionFundingAsset(strategy);
  if (funding !== budgetFundingAsset(sourceAssetId)) {
    return null;
  }
  const assets = resolvedTradeAssets(
    strategy,
    current.version.resolvedAssetsJson,
    await instructionRouteTokens(strategy),
  );
  const input = assets.find((asset) => asset.assetId === funding);
  const output = assets.find((asset) => asset.assetId !== funding);
  if (!input || !output) {
    throw new ExecutionError("not_ready", "The agent's reviewed pair is unavailable. Review it again.");
  }
  return { revision: agent.revision, quote: await quoteRhea(input, output, units.toString(), 1, pool) };
}

export async function prepareNativeFunding(
  db: AppDatabase,
  user: SessionUser,
  raw: unknown,
): Promise<NativeFundingView> {
  const input = nativeFundingRequestSchema.parse(raw),
    active = await activeNativeFunding(db, user.id);
  if (active) {
    if (active.snapshot.agentId !== (input.agentId ?? null)) {
      throw new ExecutionError("conflict", "Finish the existing native funding request first.");
    }
    if (
      active.snapshot.sourceAssetId !== input.assetId ||
      BigInt(active.snapshot.units) !== parseTokenAmount(input.amount, active.snapshot.decimals)
    ) {
      throw new ExecutionError(
        "conflict",
        "Finish or cancel the existing funding review before changing its token or amount.",
      );
    }
    return active;
  }
  const subjectId = input.agentId ?? (await manualSubject(db, user.id)),
    root = await activeTradingAccount(db, user.id);
  if (!root?.backupConfirmedAt) {
    throw new ExecutionError("not_ready", "Confirm your encrypted recovery backup before funding.");
  }
  const [holding, near] = await Promise.all([
    walletTokenHolding(user.accountId, input.assetId),
    walletTokenHolding(user.accountId, "native:near"),
  ]);
  const assetId = input.assetId === "native:near" ? "nep141:wrap.near" : input.assetId,
    units = parseTokenAmount(input.amount, holding.decimals);
  if (units <= 0n) {
    throw new ExecutionError("limit", "Choose a positive token amount.");
  }
  const storage = z
    .object({ min: positiveTokenUnitsSchema })
    .parse((await callViewFunction(assetId.slice(7), "storage_balance_bounds", {})).value);
  if (BigInt(storage.min) > 10n ** 22n) {
    throw new ExecutionError("limit", "This token's registration cost is above the supported funding limit.");
  }
  const fundingQuote = input.agentId
    ? await publicFundingQuote(db, user.id, input.agentId, input.assetId, units)
    : null;
  return userTransaction(db, user.id, async (tx) => {
    const existing = await activeNativeFunding(tx, user.id);
    if (existing) {
      if (existing.snapshot.agentId !== (input.agentId ?? null)) {
        throw new ExecutionError("conflict", "Another native funding request was created.");
      }
      if (existing.snapshot.sourceAssetId !== input.assetId || BigInt(existing.snapshot.units) !== units) {
        throw new ExecutionError(
          "conflict",
          "Another funding review already holds a different token or amount.",
        );
      }
      return existing;
    }
    const now = await databaseTime(tx),
      current = await activeTradingAccount(tx, user.id);
    if (
      current?.id !== root.id ||
      !current.backupConfirmedAt ||
      now - Math.min(holding.observedAt, near.observedAt) >= 15000
    ) {
      throw new ExecutionError(
        "not_ready",
        "The wallet or recovery account changed. Refresh the funding review.",
      );
    }
    let excludeId: string | undefined;
    if (input.agentId) {
      const agent = await ownedAgent(tx, user.id, input.agentId),
        strategy = (await currentAgentStrategy(tx, user.id, input.agentId, agent.revision)).strategy;
      if (agent.status === "running") {
        throw new ExecutionError("not_ready", "Pause the agent before funding its public trading balance.");
      }
      const setup = await linkedAgentBudget(tx, user.id, agent.id);
      if (
        !setup.budget ||
        setup.budget.assetId !== input.assetId ||
        BigInt(setup.budget.walletReservedUnits ?? setup.budget.units) !== units
      ) {
        throw new ExecutionError(
          "conflict",
          "Fund the exact remaining token budget selected for this agent.",
        );
      }
      const oldHunter = strategy.kind === "meme_hunter" && strategy.payAssetId === "nep141:wrap.near";
      if (fundingQuote && fundingQuote.revision !== agent.revision) {
        throw new ExecutionError("conflict", "The agent changed. Refresh the funding review.");
      }
      const exactPublicSwap =
        "format" in strategy &&
        usesPublicRoute(strategy) &&
        instructionFundingAsset(strategy) === budgetFundingAsset(input.assetId);
      if (!exactPublicSwap && !(oldHunter && strategy.payAssetId === assetId)) {
        throw new ExecutionError(
          "not_ready",
          "Fund the exact spending token reviewed for this public route.",
        );
      }
      if (
        fundingQuote &&
        (await committedCapital(tx, user.id, agent.id)) + BigInt(fundingQuote.quote.inputMicroUsd) >
          parseUsd(policySchema.parse(JSON.parse(agent.policyJson)).budgetUsd)
      ) {
        throw new ExecutionError("limit", "The funded amount exceeds this agent's capital limit.");
      }
      excludeId = setup.id;
    }
    const budgets = await reservedWalletBudgets(tx, user.id, undefined, excludeId);
    const reserved = (id: string): bigint =>
      budgets.reduce(
        (sum, b) =>
          sum +
          (b.accountId === user.accountId && b.assetId === id
            ? BigInt(b.walletReservedUnits ?? b.units)
            : 0n),
        0n,
      );
    const overhead = BigInt(NATIVE_FUNDING_GAS) + BigInt(storage.min) + 1n;
    if (
      BigInt(holding.spendableUnits) - reserved(input.assetId) <
        units + (input.assetId === "native:near" ? overhead : 0n) ||
      BigInt(near.spendableUnits) - reserved("native:near") <
        overhead + (input.assetId === "native:near" ? units : 0n)
    ) {
      throw new ExecutionError(
        "insufficient_funds",
        "The token amount and native fees must fit your unallocated wallet balance.",
      );
    }
    const snapshot = nativeFundingSnapshotSchema.parse({
      id: input.requestId,
      userId: user.id,
      accountId: user.accountId,
      subjectId,
      agentId: input.agentId ?? null,
      rootId: root.id,
      nativeAccountId: root.nativeAccountId,
      sourceAssetId: input.assetId,
      assetId,
      units: units.toString(),
      ...(fundingQuote ? { principalMicroUsd: fundingQuote.quote.inputMicroUsd } : {}),
      decimals: holding.decimals,
      tokenSymbol: input.assetId === "native:near" ? "wNEAR" : holding.symbol,
      gasUnits: NATIVE_FUNDING_GAS,
      registrationUnits: storage.min,
    });
    const [row] = await tx
      .insert(nativeDeposits)
      .values({
        id: input.requestId,
        userId: user.id,
        subjectId,
        snapshotJson: JSON.stringify(snapshot),
        snapshotHash: executionHash(snapshot),
        state: "prepared",
        createdAt: now,
        expiresAt: now + 300_000,
      })
      .returning();
    if (!row) {
      throw new Error("The native funding request could not be stored.");
    }
    return nativeFundingView(row);
  });
}
