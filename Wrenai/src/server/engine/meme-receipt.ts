import "server-only";
import { and, desc, eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionFills } from "@/server/db/execution-schema";
import { ExecutionError } from "@/server/execution/contracts";
import { readPreparedOrder } from "@/server/execution/intents-order";
import { ownedExecution } from "@/server/execution/records";
import { readRheaPrepared } from "@/server/execution/rhea/order";
import { applySpotFill } from "./instruction-receipt";
import {
  type MemeInstruction,
  type MemeState,
  memeSlot,
  memeSpotInstruction,
  replaceMemePosition,
} from "./meme-state";

export async function applyMemeReceipt(
  db: AppDatabase,
  userId: string,
  agentId: string,
  version: number,
  instruction: MemeInstruction,
  state: MemeState,
): Promise<MemeState | null> {
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
  const id = state.pendingActionId ?? latest?.id;
  if (!id || id === state.lastActionId) {
    return null;
  }
  const action = await ownedExecution(db, userId, id);
  if (
    action.reservationReleasedAt === null ||
    action.agentId !== agentId ||
    action.strategyVersion !== version
  ) {
    throw new ExecutionError("not_ready", "Reconcile the hunter's existing action before another signal.");
  }
  const signal =
    action.scope === "native_near"
      ? (await readRheaPrepared(db, action)).signal
      : (await readPreparedOrder(db, action)).signal;
  const position = state.positions.find((p) => p.asset.assetId === state.pendingAssetId);
  if (
    !position ||
    !signal?.instructionSlot ||
    signal.instructionSlot !== memeSlot(position) ||
    !position.spot.pendingSlot ||
    (signal.purpose !== "instruction_entry" && signal.purpose !== "instruction_exit")
  ) {
    throw new ExecutionError("conflict", "The hunter receipt does not own its persisted exact-token slot.");
  }
  const entry = signal.purpose === "instruction_entry";
  if (
    signal.inputAssetId !== (entry ? instruction.payAssetId : position.asset.assetId) ||
    signal.outputAssetId !== (entry ? position.asset.assetId : instruction.payAssetId)
  ) {
    throw new ExecutionError("conflict", "The hunter receipt changed the candidate or direction.");
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
    throw new ExecutionError("conflict", "The hunter requires one terminal, fully reconciled swap receipt.");
  }
  const spot = applySpotFill(
    memeSpotInstruction(instruction, position.asset.assetId),
    position.spot,
    id,
    position.spot.pendingSlot,
    entry,
    fills[0] ?? null,
  );
  const next = replaceMemePosition(state, { ...position, spot });
  return {
    ...next,
    lastActionId: id,
    pendingActionId: null,
    pendingAssetId: null,
    seen: [...new Set([...state.seen, position.asset.assetId])],
    positions: next.positions.filter((p) => p.spot.quantityUnits !== "0"),
  };
}
