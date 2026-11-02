import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { strategyVersions } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { instructionAssets } from "@/shared/agent-instructions";
import { strategySchema, strategySymbols } from "@/shared/agents";
import { ExecutionError, type ExecutionPlan, hashSchema } from "./contracts";
import { executionHash } from "./records";

const bindingsSchema = z.strictObject({
  strategyHash: hashSchema,
  metadataHash: hashSchema.optional(),
  assets: z
    .array(
      z.strictObject({
        symbol: z.string().min(1).max(180),
        assetId: z
          .string()
          .min(3)
          .max(256)
          .regex(/^[^\s:*]+:[^\s*]+$/),
      }),
    )
    .min(1)
    .max(6),
});

/** Canonical IDs must be resolved by the verified provider/strategy review path, never by a proposal. */
export async function checkStrategyAssets(
  db: AppDatabase,
  plan: Pick<ExecutionPlan, "agentId" | "strategyVersion" | "inputAssetId" | "outputAssetId">,
): Promise<void> {
  const [version] = await db
    .select()
    .from(strategyVersions)
    .where(
      and(eq(strategyVersions.agentId, plan.agentId), eq(strategyVersions.version, plan.strategyVersion)),
    )
    .limit(1);
  if (version === undefined || version.resolvedAssetsJson === null) {
    throw new ExecutionError(
      "not_ready",
      "The strategy's exact assets must be resolved and reviewed before execution.",
    );
  }
  const strategy = strategySchema.parse(JSON.parse(version.configJson));
  const bindings = bindingsSchema.parse(JSON.parse(version.resolvedAssetsJson));
  if ("format" in strategy) {
    const expected = instructionAssets(strategy);
    if (
      bindings.strategyHash !== executionHash(strategy) ||
      bindings.assets.length !== expected.length ||
      new Set(bindings.assets.map((asset) => asset.assetId)).size !== expected.length ||
      bindings.assets.some((asset) => !expected.includes(asset.assetId) || asset.symbol !== asset.assetId)
    ) {
      throw new ExecutionError("not_ready", "The resolved tokens do not match the reviewed instruction.");
    }
    if (!expected.includes(plan.inputAssetId) || !expected.includes(plan.outputAssetId)) {
      throw new ExecutionError("limit", "The trade includes a token outside the reviewed instruction.");
    }
    return;
  }
  const symbols = new Set(strategySymbols(strategy));
  const assetIds = new Set(bindings.assets.map((asset) => asset.assetId));
  if (
    bindings.strategyHash !== executionHash(strategy) ||
    assetIds.size !== symbols.size ||
    new Set(bindings.assets.map((asset) => asset.symbol)).size !== symbols.size ||
    bindings.assets.length !== symbols.size ||
    bindings.assets.some((asset) => ![...symbols].some((symbol) => symbol === asset.symbol))
  ) {
    throw new ExecutionError("not_ready", "The resolved assets do not match the reviewed strategy.");
  }
  if (!assetIds.has(plan.inputAssetId) || !assetIds.has(plan.outputAssetId)) {
    throw new ExecutionError("limit", "The trade includes an asset outside the reviewed strategy.");
  }
}
