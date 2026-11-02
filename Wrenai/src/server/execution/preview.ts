import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { killSwitchEngaged } from "@/server/agents/records";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import { tradePreviews } from "@/server/db/preview-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { evaluateGuard } from "@/server/guard/evaluate";
import { assignedCapitalLimit, committedCapital } from "@/server/positions/capital-records";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { intentTokens } from "@/server/research/intents";
import { instructionFundingAsset } from "@/shared/agent-instructions";
import { parseUsd, policySchema } from "@/shared/agents";
import { minimumUnits } from "@/shared/token-units";
import {
  type TradeBalance,
  type TradePreview,
  type TradePreviewInput,
  type TradeQuote,
  tradePreviewInputSchema,
  tradePreviewSchema,
} from "@/shared/trade-preview";
import { currentAgentStrategy, registryTradeAsset, resolvedTradeAssets } from "./asset-review";
import { privateBalanceToken } from "./balance-session";
import { freshTradingBalances } from "./balances";
import { ExecutionError } from "./contracts";
import { freshDryQuote } from "./oneclick-quote";
import { databaseTime, executionHash } from "./records";
import { readSpendingUsage, readSubmissionUsage } from "./usage";

export function tradePreviewSnapshot(row: typeof tradePreviews.$inferSelect): TradePreview {
  const value = tradePreviewSchema.parse(JSON.parse(row.snapshotJson));
  const { evidenceHash, ...body } = value;
  if (
    evidenceHash !== row.evidenceHash ||
    executionHash(body) !== evidenceHash ||
    value.id !== row.id ||
    value.agentId !== row.agentId ||
    value.agentRevision !== row.agentRevision ||
    value.strategyVersion !== row.strategyVersion ||
    value.riskPolicyRevision !== row.riskPolicyRevision ||
    value.createdAt !== row.createdAt ||
    value.expiresAt !== row.expiresAt
  ) {
    throw new ExecutionError("not_ready", "The saved trade preview is inconsistent.");
  }
  return value;
}
export async function repeatedTradePreview(
  db: AppDatabase,
  userId: string,
  input: TradePreviewInput,
): Promise<TradePreview | null> {
  const [row] = await db
    .select()
    .from(tradePreviews)
    .where(and(eq(tradePreviews.userId, userId), eq(tradePreviews.requestId, input.requestId)))
    .limit(1);
  if (!row) {
    return null;
  }
  if (row.requestHash !== executionHash(input)) {
    throw new ExecutionError(
      "conflict",
      "This preview request belongs to another trade. Request a fresh preview.",
    );
  }
  return tradePreviewSnapshot(row);
}

export async function latestTradePreview(
  db: AppDatabase,
  userId: string,
  agentId: string,
  revision: number,
): Promise<TradePreview | null> {
  await currentAgentStrategy(db, userId, agentId, revision);
  const [row] = await db
    .select()
    .from(tradePreviews)
    .where(
      and(
        eq(tradePreviews.userId, userId),
        eq(tradePreviews.agentId, agentId),
        eq(tradePreviews.agentRevision, revision),
      ),
    )
    .orderBy(desc(tradePreviews.createdAt))
    .limit(1);
  return row ? tradePreviewSnapshot(row) : null;
}

interface PreviewProviders {
  readonly balances: typeof freshTradingBalances;
  readonly quote: typeof freshDryQuote;
  readonly session?: typeof privateBalanceToken;
}
const liveProviders: PreviewProviders = {
  balances: freshTradingBalances,
  quote: freshDryQuote,
  session: privateBalanceToken,
};

export async function createTradePreview(
  db: AppDatabase,
  user: SessionUser,
  raw: unknown,
  providers: PreviewProviders = liveProviders,
): Promise<TradePreview> {
  const input = tradePreviewInputSchema.parse(raw);
  await currentAgentStrategy(db, user.id, input.agentId, input.expectedRevision);
  const repeated = await repeatedTradePreview(db, user.id, input);
  if (repeated) {
    return repeated;
  }
  const registry = await intentTokens();
  const current = await currentAgentStrategy(db, user.id, input.agentId, input.expectedRevision);
  const strategyHash = executionHash(current.strategy);
  const assets = resolvedTradeAssets(current.strategy, current.version.resolvedAssetsJson, registry.tokens);
  const origin = assets.find((asset) => asset.assetId === input.inputAssetId);
  const funding = input.purpose === "funding";
  const reference = funding
    ? registry.tokens.find((token) => token.assetId === input.outputAssetId)
    : undefined;
  const destination = reference
    ? registryTradeAsset(reference)
    : assets.find((asset) => asset.assetId === input.outputAssetId);
  if (!origin || !destination) {
    throw new ExecutionError("not_ready", "Review the strategy's exact input and output assets first.");
  }
  if (
    funding &&
    "format" in current.strategy &&
    instructionFundingAsset(current.strategy) !== origin.assetId
  ) {
    throw new ExecutionError("not_ready", "Only the reviewed spending token can fund this agent.");
  }
  const balanceAssets = [...new Set([...assets.map((asset) => asset.assetId), destination.assetId])];
  if (balanceAssets.length > 6) {
    throw new ExecutionError(
      "not_ready",
      "This funding review exceeds the balance provider's supported token count.",
    );
  }
  const sessionToken = await providers.session?.(db, user.id);
  const readings = await Promise.allSettled([
    providers.balances(db, user.id, user.accountId, balanceAssets, "confidential", sessionToken ?? undefined),
    providers.quote(
      user.accountId,
      origin.assetId,
      destination.assetId,
      input.inputUnits,
      input.slippageBps,
      "confidential",
      undefined,
      sessionToken ?? undefined,
    ),
  ]);
  const balance: TradeBalance =
    readings[0].status === "fulfilled"
      ? readings[0].value
      : {
          scope: "confidential",
          status: "unavailable",
          observedAt: Date.now(),
          blockHeight: null,
          balances: [],
          note: "The confidential balance could not be verified. Reconnect it or request a fresh preview.",
        };
  const quote: TradeQuote | null = readings[1].status === "fulfilled" ? readings[1].value : null;
  return userTransaction(db, user.id, async (tx) => {
    const repeated = await repeatedTradePreview(tx, user.id, input);
    if (repeated) {
      return repeated;
    }
    const current = await currentAgentStrategy(tx, user.id, input.agentId, input.expectedRevision);
    if (executionHash(current.strategy) !== strategyHash) {
      throw new ExecutionError("conflict", "The strategy changed during the preview.");
    }
    const now = await databaseTime(tx);
    const policy = policySchema.parse(JSON.parse(current.agent.policyJson));
    const spending = await readSpendingUsage(tx, user.id, input.agentId, now);
    const submission = await readSubmissionUsage(tx, user.id, input.agentId, now);
    const principal = await committedCapital(tx, user.id, input.agentId);
    const ceiling = await assignedCapitalLimit(tx, user.id, input.agentId);
    const owned = await unreservedOwnedUnits(tx, user.id, input.agentId, "confidential", origin.assetId);
    const checks: TradePreview["checks"] = [
      {
        id: "assets",
        status: "passed",
        reason: "The exact assets and decimals match the reviewed strategy.",
      },
      {
        id: "quote",
        status: quote && quote.expiresAt > now ? "passed" : "blocked",
        reason:
          quote && quote.expiresAt > now
            ? "Fresh provider-signed quote with bounded minimum output."
            : "No fresh verified quote is available.",
      },
      {
        id: "balance",
        status:
          balance.status === "verified" &&
          balance.observedAt <= now &&
          now - balance.observedAt < 15_000 &&
          BigInt(balance.balances.find((item) => item.assetId === origin.assetId)?.units ?? "0") >=
            BigInt(input.inputUnits)
            ? "passed"
            : "blocked",
        reason:
          balance.status === "verified"
            ? "The balance must be fresh and cover the complete input."
            : balance.note,
      },
      {
        id: "ownership",
        status: funding || owned >= BigInt(input.inputUnits) ? "passed" : "blocked",
        reason: funding
          ? "No units are assigned until you confirm this funding review."
          : owned >= BigInt(input.inputUnits)
            ? "The agent owns sufficient unreserved input units."
            : "Allocate confirmed funds to this agent before execution.",
      },
      {
        id: "valuation",
        status: quote?.inputMicroUsd ? "passed" : "blocked",
        reason: quote?.inputMicroUsd
          ? "Risk uses the fresh signed quote's USD debit estimate, rounded up."
          : "A current debit valuation is required before checking spending limits.",
      },
      {
        id: "capital",
        status: funding
          ? principal + BigInt(quote?.inputMicroUsd ?? "0") <= parseUsd(policy.budgetUsd)
            ? "passed"
            : "blocked"
          : ceiling > 0n &&
              principal <= minimumUnits(ceiling, parseUsd(policy.budgetUsd)) &&
              spending.agentPendingMicroUsd + BigInt(quote?.inputMicroUsd ?? "0") <=
                minimumUnits(ceiling, parseUsd(policy.budgetUsd))
            ? "passed"
            : "blocked",
        reason: funding
          ? "The allocation must fit this agent's reviewed capital risk ceiling."
          : "Confirmed principal and pending commitments must fit the agent's assigned capital ceiling.",
      },
    ];
    if (!funding && quote?.inputMicroUsd) {
      const verdict = evaluateGuard(
        {
          id: input.requestId,
          agentId: input.agentId,
          tier: "private",
          kind: "swap",
          purpose: current.strategy.kind === "rebalancer" ? "rebalance" : "entry",
          sellAssetId: origin.assetId,
          buyAssetId: destination.assetId,
          destination: { type: "confidential" },
          amountMicroUsd: BigInt(quote.inputMicroUsd),
          slippageBps: input.slippageBps,
          providerFeeBps: quote.appFeeBps,
          edge: null,
        },
        {
          now,
          killSwitchEngaged: await killSwitchEngaged(tx, user.id),
          agentStatus: current.agent.status === "error" ? "stopped" : current.agent.status,
          requiresPositiveEdge: false,
          newCapitalMicroUsd: 0n,
          allowedAssetIds: new Set(assets.map((asset) => asset.assetId)),
          allowedChains: new Set(),
          limits: {
            maxTradeMicroUsd: parseUsd(policy.maxTradeUsd),
            userDailyCapMicroUsd: null,
            agentDailyCapMicroUsd: parseUsd(policy.dailyCapUsd),
            maxSlippageBps: policy.maxSlippageBps,
            maxProviderFeeBps: policy.maxProviderFeeBps,
            maxTradesPerHour: policy.maxTradesPerHour,
            approvalThresholdMicroUsd: parseUsd(policy.approvalThresholdUsd),
          },
          usage: {
            userSpent24hMicroUsd: spending.userSpent24hMicroUsd + spending.userPendingMicroUsd,
            agentSpent24hMicroUsd: spending.agentSpent24hMicroUsd + spending.agentPendingMicroUsd,
            agentCommittedMicroUsd: principal,
            agentBudgetMicroUsd: minimumUnits(ceiling, parseUsd(policy.budgetUsd)),
            agentTradesLastHour: Number(submission.submissionsLastHour),
            agentLastTradeAt:
              submission.lastSubmissionAt === null ? null : Number(submission.lastSubmissionAt),
            agentCooldownMs: policy.cooldownSeconds * 1000,
          },
          approval: { mode: policy.approvalMode, granted: false },
        },
      );
      checks.push({
        id: verdict.status === "blocked" ? verdict.rule : "guard",
        status:
          verdict.status === "approved"
            ? "passed"
            : verdict.status === "needs_approval"
              ? "approval_required"
              : "blocked",
        reason:
          verdict.status === "approved" ? "The proposed trade passes current Guard limits." : verdict.reason,
      });
    }
    const body = {
      id: randomUUID(),
      agentId: input.agentId,
      agentRevision: current.agent.revision,
      strategyVersion: current.agent.version,
      riskPolicyRevision: 0,
      createdAt: now,
      expiresAt: Math.max(now, Math.min(now + 15_000, quote?.expiresAt ?? now)),
      input: origin,
      output: destination,
      quote,
      balance,
      decision: checks.some((check) => check.status === "blocked")
        ? "blocked"
        : checks.some((check) => check.status === "approval_required")
          ? "approval_required"
          : "allowed",
      checks,
      executionEnabled: false,
      ...(input.purpose ? { purpose: input.purpose } : {}),
    };
    const normalized = tradePreviewSchema.omit({ evidenceHash: true }).parse(body);
    const result: TradePreview = { ...normalized, evidenceHash: executionHash(normalized) };
    await tx.insert(tradePreviews).values({
      id: result.id,
      userId: user.id,
      agentId: input.agentId,
      requestId: input.requestId,
      requestHash: executionHash(input),
      evidenceHash: result.evidenceHash,
      agentRevision: result.agentRevision,
      strategyVersion: result.strategyVersion,
      riskPolicyRevision: result.riskPolicyRevision,
      snapshotJson: JSON.stringify(result),
      createdAt: now,
      expiresAt: result.expiresAt,
    });
    return result;
  });
}
