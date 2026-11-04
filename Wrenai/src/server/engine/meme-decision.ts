import "server-only";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { users } from "@/server/db/schema";
import {
  type currentAgentStrategy,
  registryTradeAsset,
  resolvedInstructionAssets,
  resolvedTradeAssets,
} from "@/server/execution/asset-review";
import { privateBalanceToken } from "@/server/execution/balance-session";
import { ExecutionError } from "@/server/execution/contracts";
import { freshDryQuote } from "@/server/execution/oneclick-quote";
import { executionHash } from "@/server/execution/records";
import { nativeTokenAsset } from "@/server/execution/rhea/inventory";
import { quoteRhea, rheaTradeQuote } from "@/server/execution/rhea/quote";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { intentTokens } from "@/server/research/intents";
import { squintReport } from "@/server/squint/client";
import type { SquintReport } from "@/server/squint/contracts";
import { verifyMemeContract } from "@/server/squint/near-profile";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { policySchema } from "@/shared/agents";
import type { TradeQuote } from "@/shared/trade-preview";
import { memeDclQuote, memeMarketPrice } from "./meme-price";
import { type MemeInstruction, type MemePosition, type MemeState, memeSpotInstruction } from "./meme-state";
import { decideSpotInstruction, type InstructionDecision, spotOrderSize } from "./spot-instructions";
import { observeSpotInstruction } from "./spot-observation";

export interface MemePositionDecision {
  readonly position: MemePosition;
  readonly decision: InstructionDecision;
  readonly priceAt: number;
  readonly quoteExpiresAt: number;
  readonly riskEvidence: {
    readonly report: Pick<
      SquintReport,
      "token" | "checked_at" | "verdict" | "risk" | "coverage" | "tax" | "supply" | "holders"
    >;
    readonly checks: readonly { id: string; status: string }[];
    readonly linkedShares: readonly string[];
  } | null;
  readonly roundTripMinimumUnits: string | null;
}
type Current = Awaited<ReturnType<typeof currentAgentStrategy>>;

/** All provider I/O precedes the owner transaction; exits do not depend on another admission screen. */
export async function decideMemePosition(
  db: AppDatabase,
  current: Current,
  instruction: MemeInstruction,
  state: MemeState,
  position: MemePosition,
  suppliedQuote?: TradeQuote,
  actionId?: string,
): Promise<MemePositionDecision> {
  const tokens = position.native ? [] : (await intentTokens()).tokens;
  const assets = position.native
    ? resolvedInstructionAssets(instruction, current.version.resolvedAssetsJson, [
        await nativeTokenAsset(instruction.payAssetId),
      ])
    : resolvedTradeAssets(instruction, current.version.resolvedAssetsJson, tokens);
  const cash = assets.find((asset) => asset.assetId === instruction.payAssetId);
  const token = tokens.find((token) => token.assetId === position.asset.assetId);
  const metadata = position.native
    ? await nativeTokenAsset(position.asset.assetId)
    : token
      ? registryTradeAsset(token)
      : null;
  if (!cash || !metadata || executionHash(metadata) !== position.assetHash) {
    throw new ExecutionError("not_ready", "The hunter's exact spending token or candidate metadata changed.");
  }
  const strategy = memeSpotInstruction(instruction, position.asset.assetId);
  const spot = { ...position.spot, pendingActionId: null };
  const order = spotOrderSize(strategy, spot, Date.now());
  if (!order) {
    return {
      position,
      decision: { state: spot, signal: null, reason: "The candidate position is complete." },
      priceAt: Date.now(),
      quoteExpiresAt: 0,
      riskEvidence: null,
      roundTripMinimumUnits: null,
    };
  }
  let evidence = position.evidence;
  let riskEvidence: MemePositionDecision["riskEvidence"] = null;
  let roundTripMinimumUnits: string | null = null;
  if (order.buy) {
    if (
      state.seen.includes(position.asset.assetId) ||
      state.seen.length >= 4096 ||
      state.positions.length > instruction.maximumPositions
    ) {
      throw new ExecutionError(
        "limit",
        "This candidate was already attempted or the reviewed hunter capacity is reached.",
      );
    }
    const report = await squintReport(position.evidence.token);
    evidence = await verifyMemeContract(report, position.asset, instruction, executionHash(report));
    const { token, checked_at, verdict, risk, coverage, tax, supply, holders } = report;
    riskEvidence = {
      report: { token, checked_at, verdict, risk, coverage, tax, supply, holders },
      checks: report.checks.map(({ id, status }) => ({ id, status })),
      linkedShares: report.clusters.map((cluster) => cluster.share),
    };
    if (evidence.poolId !== position.evidence.poolId || evidence.createdAt !== position.evidence.createdAt) {
      throw new ExecutionError("not_ready", "The candidate's verified launch or liquidity identity changed.");
    }
  }
  const [baseOwned, cashOwned, price] = await Promise.all([
    unreservedOwnedUnits(
      db,
      current.agent.userId,
      current.agent.id,
      position.native ? "native_near" : "confidential",
      position.asset.assetId,
      actionId,
    ),
    unreservedOwnedUnits(
      db,
      current.agent.userId,
      current.agent.id,
      position.native ? "native_near" : "confidential",
      cash.assetId,
      actionId,
    ),
    memeMarketPrice(position.asset, cash, evidence.poolId, instruction.priceUnit),
  ]);
  const snapshot = { base: position.asset, cash, baseOwned, cashOwned, price, quote: null };
  const observed = observeSpotInstruction(strategy, spot, snapshot, Date.now());
  if (!observed.eligible) {
    return {
      position: { ...position, evidence, spot: observed.state },
      decision: { state: observed.state, signal: null, reason: observed.reason },
      priceAt: price.observedAt,
      quoteExpiresAt: 0,
      riskEvidence,
      roundTripMinimumUnits,
    };
  }
  const [owners, session] = await Promise.all([
    db.select({ accountId: users.accountId }).from(users).where(eq(users.id, current.agent.userId)).limit(1),
    position.native ? Promise.resolve(null) : privateBalanceToken(db, current.agent.userId),
  ]);
  const owner = owners[0],
    policy = policySchema.parse(JSON.parse(current.agent.policyJson));
  if (!owner || (!position.native && !session)) {
    throw new ExecutionError(
      "not_ready",
      "Connect the private balance before the hunter can quote an order.",
    );
  }
  let quote = suppliedQuote;
  if (position.native) {
    const root = await activeTradingAccount(db, current.agent.userId);
    if (!root?.backupConfirmedAt) {
      throw new ExecutionError("not_ready", "The backed-up native trading account is unavailable.");
    }
    if (!quote) {
      const nativeQuote = await quoteRhea(
        order.buy ? cash : position.asset,
        order.buy ? position.asset : cash,
        order.units.toString(),
        policy.maxSlippageBps,
        evidence.poolId,
      );
      quote = rheaTradeQuote(nativeQuote, root.nativeAccountId);
    }
  } else if (!quote) {
    quote = await freshDryQuote(
      owner.accountId,
      order.buy ? cash.assetId : position.asset.assetId,
      order.buy ? position.asset.assetId : cash.assetId,
      order.units.toString(),
      policy.maxSlippageBps,
      "confidential",
      undefined,
      session ?? undefined,
    );
  }
  if (quote.slippageBps > policy.maxSlippageBps) {
    throw new ExecutionError("limit", "The candidate quote exceeds the reviewed slippage limit.");
  }
  let quoteExpiresAt = quote.expiresAt;
  if (order.buy) {
    const reverse = position.native
      ? {
          ...quote,
          inputAssetId: position.asset.assetId,
          outputAssetId: cash.assetId,
          inputUnits: quote.minOutputUnits,
          minOutputUnits: (
            ((await memeDclQuote(
              evidence.poolId,
              position.asset.assetId.slice(7),
              cash.assetId.slice(7),
              BigInt(quote.minOutputUnits),
            )) *
              BigInt(10000 - policy.maxSlippageBps)) /
            10000n
          ).toString(),
          capturedAt: Date.now(),
        }
      : await freshDryQuote(
          owner.accountId,
          position.asset.assetId,
          cash.assetId,
          quote.minOutputUnits,
          policy.maxSlippageBps,
          "confidential",
          undefined,
          session ?? undefined,
        );
    if (
      reverse.expiresAt <= Date.now() ||
      Date.now() - reverse.capturedAt >= 15000 ||
      reverse.capturedAt > Date.now() + 1000 ||
      reverse.inputAssetId !== position.asset.assetId ||
      reverse.outputAssetId !== cash.assetId ||
      reverse.inputUnits !== quote.minOutputUnits ||
      reverse.appFeeBps > policy.maxProviderFeeBps ||
      reverse.slippageBps > policy.maxSlippageBps ||
      BigInt(reverse.minOutputUnits) * 10000n <
        BigInt(quote.inputUnits) * BigInt(10000 - instruction.maximumPriceImpactBps)
    ) {
      throw new ExecutionError(
        "not_ready",
        "A size-matched entry and exit quote exceeds the reviewed round-trip loss/impact bound.",
      );
    }
    quoteExpiresAt = Math.min(quoteExpiresAt, reverse.expiresAt, reverse.capturedAt + 15000);
    roundTripMinimumUnits = reverse.minOutputUnits;
  }
  // The explicit hunter impact cap bounds divergence from the independent pool reference.
  // Its route slippage remains separately bounded above and again by the final shared Guard.
  const decision = decideSpotInstruction(
    strategy,
    { ...policy, maxSlippageBps: instruction.maximumPriceImpactBps },
    observed.state,
    { ...snapshot, quote },
    Date.now(),
  );
  return {
    position: { ...position, evidence, spot: decision.state },
    decision,
    priceAt: price.observedAt,
    quoteExpiresAt,
    riskEvidence,
    roundTripMinimumUnits,
  };
}
