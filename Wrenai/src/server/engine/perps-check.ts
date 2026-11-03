import "server-only";
import { and, desc, eq } from "drizzle-orm";
import type { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { executionActions, executionEvents } from "@/server/db/execution-schema";
import { ExecutionError } from "@/server/execution/contracts";
import { defiPlanSchema } from "@/server/execution/defi-contracts";
import { synchronizePerpsInventory } from "@/server/execution/hyperliquid/account-state";
import { readPerpsCheckpoint } from "@/server/execution/hyperliquid/checkpoint";
import { perpsCashAssetId } from "@/server/execution/hyperliquid/contracts";
import { hlUnits } from "@/server/execution/hyperliquid/decimal";
import { readHlMarket } from "@/server/execution/hyperliquid/market";
import type { PerpsInstruction } from "@/server/execution/hyperliquid/order-plan";
import { paymentTerminalSchema } from "@/server/execution/payment-reconciliation";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { ensureAgentTradingAccount } from "@/server/trading-accounts/agent-account";
import { instructionRequestId } from "./instruction-planning";
import { initialPerpsState, type PerpsState, perpsStateSchema } from "./perps-state";
import type { StrategyCheckPlan } from "./planning";

function result(state: PerpsState, reason: string, completed = false): StrategyCheckPlan {
  return { signal: null, intervalSeconds: 5, reason, progress: { strategyState: state, completed } };
}
export async function planPerpsCheck(
  db: AppDatabase,
  runtime: typeof agentRuntimes.$inferSelect,
  instruction: PerpsInstruction,
): Promise<StrategyCheckPlan> {
  let state = runtime.strategyStateJson
    ? perpsStateSchema.parse(JSON.parse(runtime.strategyStateJson))
    : { ...initialPerpsState };
  const checkpoint = await readPerpsCheckpoint(db, runtime.userId, runtime.agentId);
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
      throw new ExecutionError("not_ready", "Reconcile the pending venue action before another decision.");
    }
    const plan = defiPlanSchema.parse(JSON.parse(latest.planJson));
    if (plan.funding && latest.status === "settled") {
      const [terminal] = await db
        .select()
        .from(executionEvents)
        .where(
          and(eq(executionEvents.actionId, latest.id), eq(executionEvents.kind, "perps_funding_terminal")),
        )
        .limit(1);
      const details = terminal ? paymentTerminalSchema.parse(JSON.parse(terminal.detailJson)) : null;
      if (!details) {
        throw new ExecutionError("not_ready", "The venue funding has no complete final accounting.");
      }
      state = { ...state, phase: BigInt(details.amountOut) > 0n ? "entry" : "completed" };
      if (details.status === "REFUNDED") {
        state = { ...state, phase: "completed" };
      }
    } else if (latest.status === "settled") {
      if (checkpoint && checkpoint.quantity !== "0") {
        state = {
          ...state,
          phase: "holding",
          quantityUnits: checkpoint.quantity,
          entryActionId: checkpoint.entryActionId,
          watermark: checkpoint.watermark,
          stopPrice: checkpoint.stop,
        };
      } else {
        const [noFill] = await db
          .select({ id: executionEvents.id })
          .from(executionEvents)
          .where(and(eq(executionEvents.actionId, latest.id), eq(executionEvents.kind, "hl_no_fill")))
          .limit(1);
        if (!noFill) {
          state = { ...state, phase: "completed", quantityUnits: "0" };
        }
      }
    }
    state = { ...state, lastActionId: latest.id, pendingActionId: null, pendingSlot: null };
    return result(
      state,
      state.phase === "completed"
        ? "The venue lifecycle is complete; remaining funds are retained."
        : "The last venue action is fully reconciled.",
      state.phase === "completed",
    );
  }
  if (checkpoint && checkpoint.quantity !== "0") {
    state = {
      ...state,
      phase: "holding",
      quantityUnits: checkpoint.quantity,
      entryActionId: checkpoint.entryActionId,
      watermark: checkpoint.watermark,
      stopPrice: checkpoint.stop,
    };
  } else if (state.phase === "holding" && checkpoint?.quantity === "0") {
    return result(
      { ...state, phase: "completed", quantityUnits: "0" },
      "The owned perpetual position is closed.",
      true,
    );
  }
  if (state.phase === "completed") {
    return result(state, "The reviewed perpetual lifecycle has completed.", true);
  }
  const expired = Date.now() >= Date.parse(instruction.expiresAt);
  if (expired && (state.phase !== "holding" || instruction.onExpiry !== "close")) {
    return result(
      state,
      state.phase === "holding"
        ? "The instruction expired. Native exits remain; no new orders will be submitted."
        : "The instruction expired before entry; unused funds are retained.",
      true,
    );
  }
  if (state.phase === "funding") {
    const account = await ensureAgentTradingAccount(db, runtime.userId, runtime.agentId);
    await synchronizePerpsInventory(db, runtime.userId, runtime.agentId);
    if (
      (await unreservedOwnedUnits(
        db,
        runtime.userId,
        runtime.agentId,
        "hyperliquid",
        perpsCashAssetId(account.perpAddress),
      )) > 0n
    ) {
      return result({ ...state, phase: "entry" }, "This agent's isolated venue cash is ready.");
    }
    const id = instructionRequestId(
      runtime.agentId,
      runtime.strategyVersion,
      `perps-funding:${state.lastActionId ?? "initial"}`,
    );
    return {
      ...result(
        { ...state, pendingSlot: id },
        "Converting the agent's allocated token into its own venue collateral.",
      ),
      perpsRequest: { type: "funding", requestId: id, exitReason: null },
    };
  }
  const market = await readHlMarket(instruction.market),
    mark = hlUnits(market.mark, 18);
  if (state.phase === "entry" && instruction.action !== "open") {
    throw new ExecutionError("not_ready", "A reduction requires this agent's existing owned venue position.");
  }
  if (state.phase === "entry" && instruction.entry.type === "price") {
    const threshold = hlUnits(instruction.entry.price, 18);
    if (instruction.entry.direction === "above" ? mark < threshold : mark > threshold) {
      return result(state, "Waiting for the reviewed perpetual entry price.");
    }
  }
  let exitReason: "stop_loss" | "take_profit" | "trailing" | "expiry" | null = null;
  if (state.phase === "holding" && instruction.action === "open") {
    const stop = state.stopPrice ?? instruction.exits.stopLossPrice,
      target = instruction.exits.takeProfitPrice;
    if (expired && instruction.onExpiry === "close") {
      exitReason = "expiry";
    } else if (
      stop &&
      (instruction.side === "long" ? mark <= hlUnits(stop, 18) : mark >= hlUnits(stop, 18))
    ) {
      exitReason = state.stopPrice !== instruction.exits.stopLossPrice ? "trailing" : "stop_loss";
    } else if (
      target &&
      (instruction.side === "long" ? mark >= hlUnits(target, 18) : mark <= hlUnits(target, 18))
    ) {
      exitReason = "take_profit";
    }
    if (exitReason === null) {
      return result(state, "Monitoring the owned position and its native protective exits.");
    }
  }
  const id = instructionRequestId(
    runtime.agentId,
    runtime.strategyVersion,
    `perps-${state.phase}:${state.lastActionId ?? "initial"}:${exitReason ?? "user"}`,
  );
  return {
    ...result(
      { ...state, pendingSlot: id },
      state.phase === "entry"
        ? "Checking the exact isolated entry, leverage and native exits."
        : "Checking a strictly position-reducing exit.",
    ),
    perpsRequest: { type: "order", requestId: id, exitReason },
  };
}
