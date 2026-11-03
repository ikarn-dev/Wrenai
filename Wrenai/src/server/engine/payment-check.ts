import "server-only";
import { and, desc, eq } from "drizzle-orm";
import type { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionEvents } from "@/server/db/execution-schema";
import { ExecutionError } from "@/server/execution/contracts";
import { paymentRecord } from "@/server/execution/payment-order";
import { paymentTerminalSchema } from "@/server/execution/payment-reconciliation";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import type { AgentInstruction } from "@/shared/agent-instructions";
import { instructionRequestId } from "./instruction-planning";
import { initialInstructionState, instructionStateSchema } from "./instruction-state";
import type { StrategyCheckPlan } from "./planning";

export async function planPaymentCheck(
  db: AppDatabase,
  runtime: typeof agentRuntimes.$inferSelect,
  instruction: Extract<AgentInstruction, { kind: "private_payments" }>,
): Promise<StrategyCheckPlan> {
  const state = runtime.strategyStateJson
    ? instructionStateSchema.parse(JSON.parse(runtime.strategyStateJson))
    : { ...initialInstructionState("private_payments"), quantityUnits: instruction.amountUnits };
  if (state.kind !== instruction.kind) {
    throw new ExecutionError("conflict", "The payment runtime belongs to a different instruction.");
  }
  const [latest] = await db
    .select()
    .from(executionActions)
    .where(
      and(
        eq(executionActions.userId, runtime.userId),
        eq(executionActions.agentId, runtime.agentId),
        eq(executionActions.strategyVersion, runtime.strategyVersion),
      ),
    )
    .orderBy(desc(executionActions.createdAt), desc(executionActions.id))
    .limit(1);
  if (latest && latest.id !== state.lastActionId) {
    if (latest.reservationReleasedAt === null) {
      throw new ExecutionError("not_ready", "Reconcile the existing payment before another attempt.");
    }
    const saved = await paymentRecord(db, latest);
    const [row] = await db
      .select()
      .from(executionEvents)
      .where(and(eq(executionEvents.actionId, latest.id), eq(executionEvents.kind, "payment_terminal")))
      .limit(1);
    const terminal = row ? paymentTerminalSchema.parse(JSON.parse(row.detailJson)) : null;
    if (!terminal && latest.status !== "cancelled") {
      throw new ExecutionError("not_ready", "The payment has no terminal recipient accounting.");
    }
    const output = BigInt(terminal?.amountOut ?? "0"),
      before = BigInt(state.quantityUnits);
    if (saved.amountUnits !== state.quantityUnits || output > before) {
      throw new ExecutionError(
        "conflict",
        "The payment receipt differs from its remaining requested amount.",
      );
    }
    const remaining = before - output;
    const next = {
      ...state,
      pendingActionId: null,
      pendingSlot: null,
      lastActionId: latest.id,
      quantityUnits: remaining.toString(),
      phase: "completed" as const,
    };
    return {
      signal: null,
      intervalSeconds: 60,
      reason:
        remaining === 0n
          ? instruction.destination === "near_wallet"
            ? "The provider confirms the exact public NEAR payout; recipient and payout are visible on-chain."
            : "The exact requested payment is confirmed."
          : "The payment was not fully delivered. Remaining funds are retained; review before retrying.",
      progress: { strategyState: next, completed: true },
    };
  }
  const now = Date.now(),
    expired = now >= Date.parse(instruction.expiresAt),
    completed = state.phase === "completed" || expired;
  if (completed || now < Date.parse(instruction.executeAfter)) {
    return {
      signal: null,
      intervalSeconds: 60,
      reason: completed
        ? "The payment window is complete; unused funds are retained."
        : "Waiting for the reviewed payment time.",
      progress: { strategyState: { ...state, phase: completed ? "completed" : state.phase }, completed },
    };
  }
  await synchronizePrivateInventory(db, runtime.userId);
  const requestId = instructionRequestId(
    runtime.agentId,
    runtime.strategyVersion,
    `payment:${state.lastActionId ?? "initial"}`,
  );
  return {
    signal: null,
    paymentRequestId: requestId,
    intervalSeconds: 60,
    reason: "Reviewing the exact recipient amount and fee ceiling before payment.",
    progress: { strategyState: { ...state, pendingSlot: requestId }, completed: false },
  };
}
