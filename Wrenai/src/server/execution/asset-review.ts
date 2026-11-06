import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { ownedAgent } from "@/server/agents/records";
import { agentEvents, strategyVersions } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { positionLots } from "@/server/db/position-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { type IntentToken, intentTokens } from "@/server/research/intents";
import { nativeNearAsset, usdcAsset } from "@/server/wallet-swap/rhea-native";
import { instructionAssets, usesNativeNearPayout } from "@/shared/agent-instructions";
import { type AssetSymbol, type Strategy, strategySchema, strategySymbols } from "@/shared/agents";
import {
  type AgentTradeAssets,
  reviewAgentAssetsSchema,
  type TradeAsset,
  tradeAssetSchema,
} from "@/shared/trade-preview";
import { WALLET_SWAP_NATIVE_OUTPUT } from "@/shared/wallet-swap";
import { ExecutionError } from "./contracts";
import { databaseTime, executionHash } from "./records";
import { nativeTokenAsset } from "./rhea/inventory";

const aliases: Readonly<Record<AssetSymbol, readonly string[]>> = {
  NEAR: ["NEAR", "WNEAR"],
  BTC: ["BTC", "WBTC"],
  ETH: ["ETH", "WETH"],
  SOL: ["SOL", "WSOL"],
  USDC: ["USDC"],
  USDT: ["USDT"],
};
export function strategyAssetSymbols(strategy: Strategy): readonly AssetSymbol[] {
  return strategySymbols(strategy);
}

export function registryTradeAsset(token: IntentToken): TradeAsset {
  return tradeAssetSchema.parse({
    symbol: token.assetId,
    assetId: token.assetId,
    tokenSymbol: token.symbol,
    blockchain: token.blockchain,
    decimals: token.decimals,
    contractAddress: token.contractAddress ?? null,
  });
}
export function instructionTradeAssets(
  strategy: Extract<Strategy, { format: 2 }>,
  tokens: readonly IntentToken[],
): readonly TradeAsset[] {
  if (usesNativeNearPayout(strategy)) {
    return instructionAssets(strategy).map((assetId) => ({
      ...(assetId === WALLET_SWAP_NATIVE_OUTPUT ? nativeNearAsset : usdcAsset()),
      symbol: assetId,
    }));
  }
  return instructionAssets(strategy).map((assetId) => {
    const token = tokens.find((candidate) => candidate.assetId === assetId);
    if (!token) {
      throw new ExecutionError("not_ready", `The reviewed token ${assetId} has no supported route.`);
    }
    return registryTradeAsset(token);
  });
}
export function assetCandidates(tokens: readonly IntentToken[], symbol: AssetSymbol): readonly TradeAsset[] {
  return tokens
    .filter(
      (token) =>
        aliases[symbol].includes(token.symbol.toUpperCase()) && /^nep141:[a-z0-9._-]+$/.test(token.assetId),
    )
    .map((token) =>
      tradeAssetSchema.parse({
        symbol,
        assetId: token.assetId,
        tokenSymbol: token.symbol,
        blockchain: token.blockchain,
        decimals: token.decimals,
        contractAddress: token.contractAddress ?? null,
      }),
    );
}

export async function currentAgentStrategy(
  db: AppDatabase,
  userId: string,
  agentId: string,
  revision: number,
): Promise<{
  readonly agent: Awaited<ReturnType<typeof ownedAgent>>;
  readonly version: typeof strategyVersions.$inferSelect;
  readonly strategy: Strategy;
}> {
  const agent = await ownedAgent(db, userId, agentId);
  if (agent.revision !== revision) {
    throw new ExecutionError("conflict", "The agent changed. Reload its latest strategy.");
  }
  const [version] = await db
    .select()
    .from(strategyVersions)
    .where(and(eq(strategyVersions.agentId, agent.id), eq(strategyVersions.version, agent.version)))
    .limit(1);
  if (!version) {
    throw new ExecutionError("not_ready", "The strategy version is missing.");
  }
  return { agent, version, strategy: strategySchema.parse(JSON.parse(version.configJson)) };
}

const storedBindings = z.strictObject({
  strategyHash: z.string().regex(/^[a-f0-9]{64}$/),
  metadataHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  assets: z
    .array(tradeAssetSchema.pick({ symbol: true, assetId: true }))
    .min(1)
    .max(6),
});
/** Bind independently verified metadata to the exact identities and metadata reviewed by the owner. */
export function resolvedInstructionAssets(
  strategy: Extract<Strategy, { format: 2 }>,
  stored: string | null,
  metadata: readonly TradeAsset[],
): readonly TradeAsset[] {
  if (stored === null) {
    return [];
  }
  const bindings = storedBindings.parse(JSON.parse(stored));
  const assets = instructionAssets(strategy).map((id) => {
    const asset = metadata.find((candidate) => candidate.assetId === id);
    if (!asset) {
      throw new ExecutionError("not_ready", `The reviewed token ${id} could not be verified.`);
    }
    return asset;
  });
  if (
    bindings.strategyHash !== executionHash(strategy) ||
    bindings.assets.length !== assets.length ||
    new Set(bindings.assets.map((a) => a.assetId)).size !== assets.length ||
    assets.some(
      (asset) =>
        !bindings.assets.some(
          (binding) => binding.assetId === asset.assetId && binding.symbol === asset.assetId,
        ),
    ) ||
    (bindings.metadataHash !== undefined && bindings.metadataHash !== executionHash(assets))
  ) {
    throw new ExecutionError("not_ready", "The reviewed token identities or metadata changed.");
  }
  return assets;
}
export function resolvedTradeAssets(
  strategy: Strategy,
  stored: string | null,
  tokens: readonly IntentToken[],
): readonly TradeAsset[] {
  if (stored === null) {
    return [];
  }
  if ("format" in strategy) {
    return resolvedInstructionAssets(strategy, stored, instructionTradeAssets(strategy, tokens));
  }
  const bindings = storedBindings.parse(JSON.parse(stored));
  const symbols = strategyAssetSymbols(strategy);
  if (
    bindings.strategyHash !== executionHash(strategy) ||
    bindings.assets.length !== symbols.length ||
    new Set(bindings.assets.map((asset) => asset.symbol)).size !== symbols.length ||
    new Set(bindings.assets.map((asset) => asset.assetId)).size !== symbols.length
  ) {
    throw new ExecutionError("not_ready", "Exact asset bindings do not match this strategy.");
  }
  const resolved = symbols.map((symbol) => {
    const binding = bindings.assets.find((asset) => asset.symbol === symbol);
    const asset = assetCandidates(tokens, symbol).find((candidate) => candidate.assetId === binding?.assetId);
    if (!asset) {
      throw new ExecutionError(
        "not_ready",
        `The reviewed ${symbol} asset is no longer in the provider registry.`,
      );
    }
    return asset;
  });
  if (bindings.metadataHash !== undefined && bindings.metadataHash !== executionHash(resolved)) {
    throw new ExecutionError(
      "not_ready",
      "Reviewed token metadata changed. Review a new strategy version before trading.",
    );
  }
  return resolved;
}

export async function readAgentTradeAssets(
  db: AppDatabase,
  userId: string,
  agentId: string,
  revision: number,
): Promise<AgentTradeAssets> {
  const current = await currentAgentStrategy(db, userId, agentId, revision);
  if (current.strategy.kind === "meme_hunter" && current.strategy.payAssetId === "nep141:wrap.near") {
    const [native] = await db
      .select({ id: positionLots.id })
      .from(positionLots)
      .where(
        and(
          eq(positionLots.userId, userId),
          eq(positionLots.agentId, agentId),
          eq(positionLots.scope, "native_near"),
          gt(positionLots.remainingUnits, 0n),
        ),
      )
      .limit(1);
    if (native) {
      const cash = await nativeTokenAsset(current.strategy.payAssetId);
      return {
        agentId,
        revision,
        strategyVersion: current.agent.version,
        choices: [{ symbol: cash.assetId, candidates: [cash] }],
        reviewed: resolvedInstructionAssets(current.strategy, current.version.resolvedAssetsJson, [cash]),
      };
    }
  }
  const tokens =
    "format" in current.strategy && usesNativeNearPayout(current.strategy)
      ? []
      : (await intentTokens()).tokens;
  if ("format" in current.strategy) {
    const ids = instructionAssets(current.strategy);
    const reference =
      tokens.find(
        (token) =>
          token.blockchain.toLowerCase() === "near" &&
          token.symbol.toUpperCase() === "USDC" &&
          !ids.includes(token.assetId),
      ) ?? tokens.find((token) => token.assetId === "nep141:wrap.near" && !ids.includes(token.assetId));
    return {
      agentId,
      revision,
      strategyVersion: current.agent.version,
      ...(reference ? { fundingReference: registryTradeAsset(reference) } : {}),
      choices: instructionTradeAssets(current.strategy, tokens).map((asset) => ({
        symbol: asset.assetId,
        candidates: [asset],
      })),
      reviewed: resolvedTradeAssets(current.strategy, current.version.resolvedAssetsJson, tokens),
    };
  }
  return {
    agentId,
    revision,
    strategyVersion: current.agent.version,
    choices: strategyAssetSymbols(current.strategy).map((symbol) => ({
      symbol,
      candidates: assetCandidates(tokens, symbol),
    })),
    reviewed: resolvedTradeAssets(current.strategy, current.version.resolvedAssetsJson, tokens),
  };
}

export async function reviewAgentTradeAssets(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<readonly TradeAsset[]> {
  const input = reviewAgentAssetsSchema.parse(raw);
  // Check ownership before any provider I/O; refresh outside the short owner transaction.
  await currentAgentStrategy(db, userId, input.agentId, input.expectedRevision);
  const registry = await intentTokens();
  return userTransaction(db, userId, async (tx) => {
    const current = await currentAgentStrategy(tx, userId, input.agentId, input.expectedRevision);
    const now = await databaseTime(tx);
    if (now - registry.source.observedAt >= 30_000 || registry.source.observedAt > now) {
      throw new ExecutionError("not_ready", "The asset registry expired. Load it again.");
    }
    const normalized = {
      strategyHash: executionHash(current.strategy),
      assets: input.assets.toSorted((a, b) => a.symbol.localeCompare(b.symbol)),
    };
    const selected = resolvedTradeAssets(current.strategy, JSON.stringify(normalized), registry.tokens);
    if (current.version.resolvedAssetsJson !== null) {
      const previous = resolvedTradeAssets(
        current.strategy,
        current.version.resolvedAssetsJson,
        registry.tokens,
      );
      if (executionHash(previous) !== executionHash(selected)) {
        throw new ExecutionError(
          "conflict",
          "Assets are already bound. Edit the strategy to review a new version.",
        );
      }
      return previous;
    }
    await tx
      .update(strategyVersions)
      .set({ resolvedAssetsJson: JSON.stringify({ ...normalized, metadataHash: executionHash(selected) }) })
      .where(eq(strategyVersions.id, current.version.id));
    await tx.insert(agentEvents).values({
      id: input.requestId,
      userId,
      agentId: input.agentId,
      kind: "assets_reviewed",
      message: "Reviewed exact strategy assets.",
      detailJson: JSON.stringify({ ...normalized, metadataHash: executionHash(selected) }),
      createdAt: now,
    });
    return selected;
  });
}
