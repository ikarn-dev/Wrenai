import "server-only";
import { and, eq } from "drizzle-orm";
import { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import {
  type MemeInstruction,
  type MemePosition,
  type MemeState,
  memeSlot,
  memeStateSchema,
} from "@/server/engine/meme-state";
import { ExecutionError, type ExecutionPlan } from "./contracts";
import { executionHash } from "./records";

export async function readMemeDecision(
  db: AppDatabase,
  userId: string,
  agentId: string,
  version: number,
  instruction: MemeInstruction,
): Promise<{ state: MemeState; position: MemePosition; stored: string; revision: number }> {
  const [runtime] = await db
    .select()
    .from(agentRuntimes)
    .where(and(eq(agentRuntimes.userId, userId), eq(agentRuntimes.agentId, agentId)))
    .limit(1);
  if (!runtime?.strategyStateJson || runtime.state !== "active" || runtime.strategyVersion !== version) {
    throw new ExecutionError("not_ready", "A persisted active hunter decision is required.");
  }
  const state = memeStateSchema.parse(JSON.parse(runtime.strategyStateJson));
  const position = state.positions.find((p) => p.asset.assetId === state.pendingAssetId);
  if (
    state.strategyHash !== executionHash(instruction) ||
    !position ||
    !memeSlot(position) ||
    position.assetHash !== executionHash(position.asset)
  ) {
    throw new ExecutionError("not_ready", "The current hunter has no bound exact-token decision.");
  }
  return { state, position, stored: runtime.strategyStateJson, revision: runtime.agentRevision };
}
/** Database-only binding, also called under the final Guard lock. Candidate IDs never come from chat. */
export function assertMemePair(
  instruction: MemeInstruction,
  decision: Awaited<ReturnType<typeof readMemeDecision>>,
  plan: Pick<ExecutionPlan, "inputAssetId" | "outputAssetId" | "inputUnits">,
): void {
  const entry = decision.position.spot.phase === "waiting";
  if (
    plan.inputAssetId !== (entry ? instruction.payAssetId : decision.position.asset.assetId) ||
    plan.outputAssetId !== (entry ? decision.position.asset.assetId : instruction.payAssetId) ||
    plan.inputUnits !== (entry ? instruction.amountUnits : decision.position.spot.quantityUnits)
  ) {
    throw new ExecutionError(
      "limit",
      "The swap does not match the hunter's persisted token, size and direction.",
    );
  }
}
