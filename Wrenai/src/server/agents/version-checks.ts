import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { type agents, strategyVersions } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { positionLots } from "@/server/db/position-schema";
import { instructionTradeAssets } from "@/server/execution/asset-review";
import { executionHash } from "@/server/execution/records";
import {
  explicitTokenIds,
  NATIVE_NEAR,
  namesBudgetToken,
  namesToken,
} from "@/server/manual-trading/token-identity";
import type { IntentToken } from "@/server/research/intents";
import { budgetFundingAsset } from "@/shared/agent-budget";
import { instructionAssets, instructionFundingAsset, usesPublicRoute } from "@/shared/agent-instructions";
import { type AgentSummary, strategySchema } from "@/shared/agents";
import { AgentError } from "./errors";

// Checks a saved strategy version must pass: its reviewed token identities, and that a funded agent never switches
// between the private and public routes.

export async function checkFundedRoute(
  db: AppDatabase,
  agent: typeof agents.$inferSelect,
  next: AgentSummary["strategy"],
): Promise<void> {
  const [version] = await db
    .select({ config: strategyVersions.configJson })
    .from(strategyVersions)
    .where(and(eq(strategyVersions.agentId, agent.id), eq(strategyVersions.version, agent.version)))
    .limit(1);
  if (!version) {
    throw new AgentError("unavailable", "The current strategy version is missing.");
  }
  const previous = strategySchema.parse(JSON.parse(version.config));
  if (("format" in previous && usesPublicRoute(previous)) === ("format" in next && usesPublicRoute(next))) {
    return;
  }
  const [owned] = await db
    .select({ id: positionLots.id })
    .from(positionLots)
    .where(
      and(
        eq(positionLots.userId, agent.userId),
        eq(positionLots.agentId, agent.id),
        gt(positionLots.remainingUnits, 0n),
      ),
    )
    .limit(1);
  if (owned) {
    throw new AgentError("conflict", "Release this agent’s allocation before switching its trading account.");
  }
}

export function reviewedInstructionAssets(
  instruction: Extract<AgentSummary["strategy"], { format: 2 }>,
  tokens: readonly IntentToken[],
  text: string,
  budgetAssetId: string | undefined,
): string | null {
  const ids = instructionAssets(instruction);
  if (ids.length === 0) {
    return null;
  }
  const assets = instructionTradeAssets(instruction, tokens);
  const explicit = explicitTokenIds(tokens, text);
  const selected = tokens.find((token) => token.assetId === budgetFundingAsset(budgetAssetId));
  const funding = instructionFundingAsset(instruction);
  if (
    ids.some(
      (id) =>
        !namesToken(explicit, id) &&
        !(
          id === funding &&
          selected?.assetId === id &&
          // "NEAR" names a native NEAR budget, which spends through 1Click's NEAR asset.
          (namesBudgetToken(selected, text) || (budgetAssetId === NATIVE_NEAR && explicit.has(NATIVE_NEAR)))
        ),
    )
  ) {
    throw new AgentError("invalid_input", "Name each token and review the strategy again.");
  }
  return JSON.stringify({
    strategyHash: executionHash(instruction),
    metadataHash: executionHash(assets),
    assets: assets
      .map(({ symbol, assetId }) => ({ symbol, assetId }))
      .toSorted((a, b) => a.symbol.localeCompare(b.symbol)),
  });
}
