import "server-only";
import { and, eq } from "drizzle-orm";
import { agentRuntimes, strategyVersions } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { instructionStateSchema } from "@/server/engine/instruction-state";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { agentInstructionSchema } from "@/shared/agent-instructions";
import type { AgentPolicy } from "@/shared/agents";
import { ExecutionError, type ExecutionPlan } from "./contracts";

/** Called under the owner lock. The flag has no authority without the reviewed rule and real owned inventory. */
export async function verifiedReducingExit(
  db: AppDatabase,
  userId: string,
  plan: ExecutionPlan,
  policy: AgentPolicy,
  actionId?: string,
): Promise<boolean> {
  if (!plan.reduceOnly) {
    return false;
  }
  if (plan.budgetMode !== "per_agent" || !policy.allowRiskReducingExits) {
    throw new ExecutionError(
      "not_ready",
      "This policy does not authorize position-reducing exits outside entry caps.",
    );
  }
  const [version] = await db
    .select()
    .from(strategyVersions)
    .where(
      and(eq(strategyVersions.agentId, plan.agentId), eq(strategyVersions.version, plan.strategyVersion)),
    )
    .limit(1);
  const parsed = agentInstructionSchema.safeParse(version ? JSON.parse(version.configJson) : null);
  if (!parsed.success) {
    throw new ExecutionError("not_ready", "A position exit requires a reviewed current instruction.");
  }
  const instruction = parsed.data;
  const [runtime] = await db
    .select()
    .from(agentRuntimes)
    .where(and(eq(agentRuntimes.userId, userId), eq(agentRuntimes.agentId, plan.agentId)))
    .limit(1);
  const state = runtime?.strategyStateJson
    ? instructionStateSchema.safeParse(JSON.parse(runtime.strategyStateJson))
    : null;
  if (
    runtime &&
    (runtime.strategyVersion !== plan.strategyVersion ||
      (state?.success && state.data.kind !== instruction.kind))
  ) {
    throw new ExecutionError(
      "not_ready",
      "The position state does not belong to the reviewed strategy version.",
    );
  }
  let input: string, output: string, maximum: bigint;
  if (instruction.kind === "sell_the_top") {
    if (
      !state?.success ||
      state.data.phase !== "holding" ||
      (!state.data.exitTriggered && state.data.pendingTarget === null)
    ) {
      throw new ExecutionError(
        "not_ready",
        "No reviewed profit target or protection rule is currently eligible.",
      );
    }
    input = instruction.sellAssetId;
    output = instruction.receiveAssetId;
    maximum = state?.success ? BigInt(state.data.quantityUnits) : BigInt(instruction.quantityUnits);
  } else if (instruction.kind === "spot_trader" || instruction.kind === "buy_the_dip") {
    input = instruction.buyAssetId;
    output = instruction.payAssetId;
    if (instruction.kind === "spot_trader" && instruction.side === "sell") {
      maximum = state?.success ? BigInt(state.data.quantityUnits) : BigInt(instruction.amountUnits);
    } else if (
      state?.success &&
      state.data.kind === instruction.kind &&
      state.data.phase === "holding" &&
      state.data.exitTriggered
    ) {
      maximum = BigInt(state.data.quantityUnits);
    } else {
      throw new ExecutionError("not_ready", "The reviewed agent has no confirmed position to reduce.");
    }
  } else {
    throw new ExecutionError("not_ready", "This strategy does not authorize a spot position exit.");
  }
  // Current-action reservations are excluded when the Signer rechecks its own action.
  const owned = await unreservedOwnedUnits(db, userId, plan.agentId, plan.scope, plan.inputAssetId, actionId);
  if (
    plan.inputAssetId !== input ||
    plan.outputAssetId !== output ||
    BigInt(plan.inputUnits) > maximum ||
    BigInt(plan.inputUnits) > owned
  ) {
    throw new ExecutionError(
      "limit",
      "An exit cannot change direction or spend beyond the agent's remaining owned position.",
    );
  }
  return true;
}
