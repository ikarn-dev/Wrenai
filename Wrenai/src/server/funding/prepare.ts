import "server-only";
import { QuoteRequest } from "@defuse-protocol/one-click-sdk-typescript";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { agentSummary, killSwitchEngaged, ownedAgent } from "@/server/agents/records";
import type { SessionUser } from "@/server/auth/session";
import type { AppDatabase } from "@/server/db/client";
import { walletFundings } from "@/server/db/funding-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { readDelegatedKey } from "@/server/delegation/delegated-key";
import { ExecutionError } from "@/server/execution/contracts";
import {
  dryQuoteRequest,
  oneClickJson,
  providerSlippageBps,
  verifiedDryQuote,
  verifiedProviderQuote,
} from "@/server/execution/oneclick-quote";
import { databaseTime, executionHash } from "@/server/execution/records";
import { walletTokenHolding } from "@/server/portfolio/wallet-tokens";
import { intentTokens } from "@/server/research/intents";
import { nearAccountSchema } from "@/shared/agent-budget";
import { instructionFundingAsset, usesPublicRoute } from "@/shared/agent-instructions";
import { parseUsd, policySchema } from "@/shared/agents";
import type { TradeQuote } from "@/shared/trade-preview";
import { type WalletFundingView, walletFundingSnapshotSchema } from "@/shared/wallet-funding";
import { linkedAgentBudget, openWalletFunding, walletFundingView } from "./records";

export const prepareWalletFundingSchema = z.strictObject({
  requestId: z.uuid(),
  agentId: z.uuid(),
  expectedRevision: z.number().int().positive(),
});

// A 1Click deposit address stays valid for this long, well past the five-minute review, so a slow wallet still lands.
const DEPOSIT_WINDOW_MS = 30 * 60_000;

/** The exact live request for native NEAR sent from the wallet straight into the owner's private balance. */
export function nativeDepositRequest(
  accountId: string,
  units: string,
  slippageBps: number,
  deadline: string,
): QuoteRequest {
  return {
    dry: false,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    slippageTolerance: providerSlippageBps(slippageBps),
    // 1Click's NEAR asset. The wallet sends plain NEAR; nothing is wrapped in the wallet.
    originAsset: "nep141:wrap.near",
    destinationAsset: "nep141:wrap.near",
    amount: units,
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    recipientType: QuoteRequest.recipientType.CONFIDENTIAL_INTENTS,
    // A failed delivery refunds to the wallet that sent it.
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    recipient: accountId,
    refundTo: accountId,
    deadline,
    quoteWaitingTimeMs: 0,
    appFees: [],
  };
}

async function nativeDepositQuote(
  accountId: string,
  units: string,
  slippageBps: number,
): Promise<{
  readonly quote: TradeQuote;
  readonly direct: { readonly depositAddress: string; readonly requestDeadline: string };
}> {
  const deadline = new Date(Date.now() + DEPOSIT_WINDOW_MS).toISOString(),
    request = nativeDepositRequest(accountId, units, slippageBps, deadline);
  const raw = await oneClickJson("/v0/quote", request);
  const quote = verifiedProviderQuote(raw, request, "intents", Date.now(), slippageBps);
  const deposit = z
    .object({
      quote: z.object({
        depositAddress: nearAccountSchema,
        depositMemo: z.union([z.literal(""), z.null()]).optional(),
      }),
    })
    .parse(raw).quote;
  return { quote, direct: { depositAddress: deposit.depositAddress, requestDeadline: deadline } };
}

async function tokenDepositQuote(
  accountId: string,
  assetId: string,
  units: string,
  slippageBps: number,
): Promise<{ readonly quote: TradeQuote; readonly direct: null }> {
  const request = {
    ...dryQuoteRequest(accountId, assetId, assetId, units, slippageBps, "intents", Date.now()),
    recipientType: QuoteRequest.recipientType.CONFIDENTIAL_INTENTS,
  };
  const quote = verifiedDryQuote(
    await oneClickJson("/v0/quote", request),
    request,
    "intents",
    Date.now(),
    slippageBps,
  );
  return { quote, direct: null };
}

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
    .where(and(eq(walletFundings.userId, user.id), eq(walletFundings.agentId, agent.id), openWalletFunding()))
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
  if ("format" in summary.strategy && usesPublicRoute(summary.strategy)) {
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
  const { quote, direct } =
    budget.assetId === "native:near"
      ? await nativeDepositQuote(user.accountId, units, policy.maxSlippageBps)
      : await tokenDepositQuote(user.accountId, assetId, units, policy.maxSlippageBps);
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
    ...(direct ?? {}),
  });
  return userTransaction(db, user.id, async (tx) => {
    const current = await ownedAgent(tx, user.id, agent.id),
      latest = await linkedAgentBudget(tx, user.id, agent.id),
      now = await databaseTime(tx);
    const [pending] = await tx
      .select()
      .from(walletFundings)
      .where(
        and(eq(walletFundings.userId, user.id), eq(walletFundings.agentId, agent.id), openWalletFunding()),
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
