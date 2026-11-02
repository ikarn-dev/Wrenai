import "server-only";
import { and, desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionFills } from "@/server/db/execution-schema";
import { ExecutionError } from "@/server/execution/contracts";
import { readPreparedOrder } from "@/server/execution/intents-order";
import { ownedExecution } from "@/server/execution/records";
import type { InstructionState } from "./instruction-state";
import type { SpotInstruction } from "./spot-instructions";

export interface InstructionFill {
  readonly input: bigint;
  readonly output: bigint;
  readonly occurredAt: number;
}
export function applySpotFill(
  instruction: SpotInstruction,
  previous: InstructionState,
  actionId: string,
  slot: string,
  entry: boolean,
  fill: InstructionFill | null,
): InstructionState {
  if (previous.lastActionId === actionId) {
    return { ...previous, pendingActionId: null };
  }
  const next = {
    ...previous,
    lastActionId: actionId,
    lastSlot: slot,
    pendingSlot: null,
    pendingActionId: null,
    confirmationSince: null,
  };
  if (!fill) {
    return { ...next, pendingTarget: null, resetRequired: instruction.kind === "buy_the_dip" && entry };
  }
  if (entry) {
    if (
      instruction.kind === "sell_the_top" ||
      (instruction.kind === "spot_trader" && instruction.side === "sell") ||
      (instruction.kind !== "dca" && previous.phase !== "waiting")
    ) {
      throw new ExecutionError("conflict", "An entry cannot replace this agent's existing position.");
    }
    const quantity = BigInt(previous.quantityUnits) + fill.output;
    const noExit =
      instruction.kind !== "dca" &&
      instruction.onExpiry === "stop" &&
      Object.values(instruction.exits).every((value) => value === null);
    const phase =
      instruction.kind === "dca"
        ? previous.runs + 1 >= instruction.maxRuns
          ? "completed"
          : "waiting"
        : noExit
          ? instruction.kind === "buy_the_dip" && previous.runs + 1 < instruction.maxEntries
            ? "waiting"
            : "completed"
          : "holding";
    return {
      ...next,
      phase,
      runs: previous.runs + 1,
      quantityUnits: quantity.toString(),
      lastEntryAt: fill.occurredAt,
      resetRequired: instruction.kind === "buy_the_dip" && noExit,
      exitTriggered: false,
    };
  }
  if (fill.input > BigInt(previous.quantityUnits) || previous.quantityUnits === "0") {
    throw new ExecutionError("conflict", "The exit receipt exceeds this agent's confirmed position.");
  }
  const remaining = BigInt(previous.quantityUnits) - fill.input;
  if (instruction.kind === "sell_the_top") {
    const completedTargets = [...previous.completedTargets],
      targetSoldUnits = [...previous.targetSoldUnits];
    const index = previous.pendingTarget;
    if (index !== null) {
      const target = instruction.targets[index];
      if (!target) {
        throw new ExecutionError("conflict", "The receipt has no reviewed profit target.");
      }
      const sold = BigInt(targetSoldUnits[index] ?? "0") + fill.input;
      while (targetSoldUnits.length <= index) {
        targetSoldUnits.push("0");
      }
      targetSoldUnits[index] = sold.toString();
      if (sold >= (BigInt(instruction.quantityUnits) * BigInt(target.sellBps)) / 10_000n) {
        completedTargets.push(index);
      }
    }
    return {
      ...next,
      quantityUnits: remaining.toString(),
      targetSoldUnits,
      completedTargets,
      pendingTarget: null,
      phase:
        remaining === 0n || completedTargets.length === instruction.targets.length ? "completed" : "holding",
    };
  }
  const rearm = instruction.kind === "buy_the_dip" && previous.runs < instruction.maxEntries;
  return {
    ...next,
    quantityUnits: remaining.toString(),
    phase: remaining > 0n ? previous.phase : rearm ? "waiting" : "completed",
    exitTriggered: remaining > 0n && previous.exitTriggered,
    resetRequired: rearm && remaining === 0n,
    peakPrice: remaining === 0n ? null : previous.peakPrice,
  };
}

/** The latest immutable action also recovers a crash between reservation and recording its runtime ID. */
export async function applyInstructionReceipt(
  db: AppDatabase,
  userId: string,
  agentId: string,
  version: number,
  instruction: SpotInstruction,
  previous: InstructionState,
): Promise<InstructionState | null> {
  const [latest] = await db
    .select({ id: executionActions.id })
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, userId),
        eq(executionActions.agentId, agentId),
        eq(executionActions.strategyVersion, version),
      ),
    )
    .orderBy(desc(executionActions.createdAt), desc(executionActions.id))
    .limit(1);
  const id = previous.pendingActionId ?? latest?.id;
  if (!id || id === previous.lastActionId) {
    return null;
  }
  const action = await ownedExecution(db, userId, id);
  if (
    action.agentId !== agentId ||
    action.strategyVersion !== version ||
    action.reservationReleasedAt === null
  ) {
    throw new ExecutionError(
      "not_ready",
      "Reconcile this instruction's previous order before another signal.",
    );
  }
  const signal = (await readPreparedOrder(db, action)).signal;
  if (
    !signal?.instructionSlot ||
    (signal.purpose !== "instruction_entry" && signal.purpose !== "instruction_exit") ||
    previous.pendingSlot !== signal.instructionSlot
  ) {
    throw new ExecutionError("conflict", "The receipt has no matching persisted instruction slot.");
  }
  const fills = await db
    .select({
      input: executionFills.inputUnits,
      output: executionFills.outputUnits,
      occurredAt: executionFills.occurredAt,
    })
    .from(executionFills)
    .where(and(eq(executionFills.userId, userId), eq(executionFills.actionId, id)))
    .limit(2);
  if (fills.length > 1) {
    throw new ExecutionError("conflict", "This instruction requires one complete terminal swap receipt.");
  }
  return applySpotFill(
    instruction,
    previous,
    id,
    signal.instructionSlot,
    signal.purpose === "instruction_entry",
    fills[0] ?? null,
  );
}
