import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { perpsStateSchema } from "@/server/engine/perps-state";
import { agentInstructionSchema } from "@/shared/agent-instructions";
import { policySchema } from "@/shared/agents";
import { currentAgentStrategy } from "../asset-review";
import { ExecutionError } from "../contracts";
import { defiPlanSchema } from "../defi-contracts";
import { databaseTime, executionHash, ownedLedgerAction } from "../records";
import { readHlAccount, synchronizePerpsInventory } from "./account-state";
import { hlDecimalSchema } from "./contracts";
import { hlText, hlUnits } from "./decimal";
import { readHlRequest, sendHlRequest } from "./journal";
import { readHlMarket, verifyHlDepth } from "./market";
import { readHlOpenOrders, verifyHlFee } from "./observations";
import { composePerpsOrder } from "./order-plan";
import { readHlOrder } from "./order-record";
import { hlInfo } from "./transport";

export async function executePerpsAction(
  db: AppDatabase,
  userId: string,
  actionId: string,
  token: string,
): Promise<void> {
  const action = await ownedLedgerAction(db, userId, actionId),
    plan = defiPlanSchema.parse(JSON.parse(action.planJson)),
    saved = await readHlOrder(db, action);
  const current = await currentAgentStrategy(db, userId, action.agentId, action.agentRevision),
    instruction = current.strategy;
  if (
    instruction.kind !== "perps" ||
    action.status !== "reserved" ||
    plan.scope !== "hyperliquid" ||
    executionHash(instruction) !== saved.instructionHash ||
    executionHash(saved.action) !== plan.payloadHash ||
    saved.action.type !== "order"
  ) {
    throw new ExecutionError("conflict", "The venue order differs from its current reviewed instruction.");
  }
  const effective =
    saved.exitReason !== null && saved.exitReason !== "user"
      ? agentInstructionSchema.parse({
          ...instruction,
          action: "close",
          quantity: hlText(BigInt(saved.requestedUnits), saved.market.sizeDecimals),
        })
      : instruction;
  if (effective.kind !== "perps") {
    throw new ExecutionError("conflict", "This is not a Perps order.");
  }
  const policy = policySchema.parse(JSON.parse(current.agent.policyJson));
  const recomposed = composePerpsOrder(
    effective,
    policy,
    saved.market,
    action.requestId,
    BigInt(saved.availableCashUnits),
    BigInt(saved.beforeExposureUnits),
    saved.market.observedAt,
  );
  if (
    executionHash(recomposed.action) !== plan.payloadHash ||
    executionHash(recomposed.leverage) !== executionHash(saved.leverage)
  ) {
    throw new ExecutionError(
      "conflict",
      "The signed order would change its side, exact size, native exits or leverage.",
    );
  }
  const fresh = await readHlMarket(instruction.market);
  if (fresh.asset !== saved.market.asset || fresh.sizeDecimals !== saved.market.sizeDecimals) {
    throw new ExecutionError("not_ready", "The venue market identity changed before signing.");
  }
  const parent = saved.action.orders[0];
  if (!parent?.c) {
    throw new ExecutionError("conflict", "The venue order is missing its stable client identity.");
  }
  const price = hlUnits(parent.p, 18),
    mark = hlUnits(fresh.mark, 18),
    bps = BigInt(policy.maxSlippageBps);
  if (saved.role === "entry") {
    if (
      instruction.entry.type === "price" &&
      (instruction.entry.direction === "above"
        ? mark < hlUnits(instruction.entry.price, 18)
        : mark > hlUnits(instruction.entry.price, 18))
    ) {
      throw new ExecutionError("not_ready", "The reviewed entry condition is no longer met.");
    }
    for (const wire of saved.action.orders) {
      if ("trigger" in wire.t) {
        const trigger = hlUnits(wire.t.trigger.triggerPx, 18),
          above = wire.t.trigger.tpsl === "sl" ? wire.b : !wire.b;
        if (above ? trigger <= mark : trigger >= mark) {
          throw new ExecutionError(
            "not_ready",
            "The market crossed a reviewed protective trigger before entry.",
          );
        }
      }
    }
  }
  if (parent.b ? price * 10000n > mark * (10000n + bps) : price * 10000n < mark * (10000n - bps)) {
    throw new ExecutionError("not_ready", "The market moved beyond the reviewed order's slippage bound.");
  }
  verifyHlDepth(fresh, parent.b, BigInt(saved.requestedUnits), parent.p);
  await verifyHlFee(saved.address, policy.maxProviderFeeBps);
  if (saved.role === "entry") {
    const open = await readHlOpenOrders(saved.address);
    if (open.length > 0) {
      throw new ExecutionError("not_ready", "Reconcile existing venue orders before opening a new position.");
    }
  }
  const validateSlot = async (tx: AppDatabase): Promise<void> => {
    const [runtime] = await tx
      .select()
      .from(agentRuntimes)
      .where(and(eq(agentRuntimes.userId, userId), eq(agentRuntimes.agentId, action.agentId)))
      .limit(1);
    const state = runtime?.strategyStateJson
        ? perpsStateSchema.parse(JSON.parse(runtime.strategyStateJson))
        : null,
      now = await databaseTime(tx);
    if (
      runtime?.state !== "active" ||
      runtime.strategyVersion !== action.strategyVersion ||
      runtime.agentRevision !== action.agentRevision ||
      state?.pendingSlot !== action.requestId ||
      (state.pendingActionId !== null && state.pendingActionId !== action.id) ||
      state.phase !== (saved.role === "entry" ? "entry" : "holding") ||
      (saved.role === "entry" && now >= Date.parse(instruction.expiresAt))
    ) {
      throw new ExecutionError(
        "not_ready",
        "The reviewed Perps decision slot changed or expired before signing.",
      );
    }
    if (saved.exitReason !== null && saved.exitReason !== "user") {
      const long = instruction.side === "long",
        stop = saved.exitReason === "trailing" ? state.stopPrice : instruction.exits.stopLossPrice;
      const eligible =
        saved.exitReason === "expiry"
          ? instruction.onExpiry === "close" && now >= Date.parse(instruction.expiresAt)
          : saved.exitReason === "take_profit"
            ? instruction.exits.takeProfitPrice !== null &&
              (long
                ? mark >= hlUnits(instruction.exits.takeProfitPrice, 18)
                : mark <= hlUnits(instruction.exits.takeProfitPrice, 18))
            : stop !== null && (long ? mark <= hlUnits(stop, 18) : mark >= hlUnits(stop, 18));
      if (!eligible) {
        throw new ExecutionError("not_ready", "The reviewed protective exit condition is no longer met.");
      }
    }
  };
  if (saved.leverage) {
    if (!(await readHlRequest(db, action, "leverage"))) {
      await sendHlRequest(db, action, token, "leverage", saved.leverage, validateSlot);
    }
    const leverage = z
      .object({
        user: z.string(),
        coin: z.literal(instruction.market),
        leverage: z.object({ type: z.literal("isolated"), value: z.literal(instruction.leverage) }),
        markPx: hlDecimalSchema,
      })
      .safeParse(await hlInfo({ type: "activeAssetData", user: saved.address, coin: instruction.market }));
    if (!leverage.success || leverage.data.user.toLowerCase() !== saved.address.toLowerCase()) {
      return;
    }
  }
  const observed = await readHlAccount(saved.address),
    actual = observed.assetPositions.find((p) => p.position.coin === instruction.market)?.position;
  const signedBefore =
    instruction.side === "long" ? BigInt(saved.beforeExposureUnits) : -BigInt(saved.beforeExposureUnits);
  if (
    (actual ? hlUnits(actual.szi, fresh.sizeDecimals) : 0n) !== signedBefore ||
    hlUnits(observed.crossMarginSummary.totalRawUsd, 6, "down").toString() !== saved.beforeCashUnits
  ) {
    throw new ExecutionError("not_ready", "The account's cash or exposure changed before order submission.");
  }
  await synchronizePerpsInventory(db, userId, action.agentId);
  await sendHlRequest(db, action, token, "trade", saved.action, validateSlot);
}
