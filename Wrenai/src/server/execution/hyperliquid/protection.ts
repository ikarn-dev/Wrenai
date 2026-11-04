import "server-only";
import { and, desc, eq, like } from "drizzle-orm";
import { killSwitchEngaged, ownedAgent } from "@/server/agents/records";
import { strategyVersions } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { defiPositions } from "@/server/db/defi-schema";
import { executionEvents } from "@/server/db/execution-schema";
import { manualPerpsContext } from "@/server/manual-trading/perps-context";
import { agentInstructionSchema } from "@/shared/agent-instructions";
import { policySchema } from "@/shared/agents";
import { ExecutionError } from "../contracts";
import { defiPlanSchema } from "../defi-contracts";
import { requireExecutionPermission } from "../permissions";
import { databaseTime, executionHash, type LedgerAction, ownedLedgerAction } from "../records";
import type { PerpsCheckpoint } from "./checkpoint";
import { perpsInstrumentId } from "./contracts";
import { hlText, hlUnits } from "./decimal";
import { readHlRequest, sendHlRequest } from "./journal";
import { readHlMarket } from "./market";
import { readHlOpenOrders, readHlOrderStatus } from "./observations";
import { perpsOrderIdentities } from "./order-identities";
import { composePerpsOrder, composePerpsProtection, tightenedPerpsStop } from "./order-plan";
import type { HlOrderRecord } from "./order-record";
import { confirmedProtectionIndex, recordConfirmedProtection } from "./protection-progress";

/** Preserve native protection while updating; reduce-only orders can never flip or add exposure. */
export async function maintainPerpsProtection(
  db: AppDatabase,
  entry: LedgerAction,
  saved: HlOrderRecord,
  quantity: bigint,
  checkpoint?: PerpsCheckpoint,
): Promise<{ readonly protected: boolean; readonly watermark: string; readonly stop: string }> {
  const [version] = await db
    .select()
    .from(strategyVersions)
    .where(
      and(eq(strategyVersions.agentId, entry.agentId), eq(strategyVersions.version, entry.strategyVersion)),
    )
    .limit(1);
  const manual = entry.origin === "manual" ? await manualPerpsContext(db, entry) : null;
  const instruction =
    manual?.instruction ?? agentInstructionSchema.parse(version ? JSON.parse(version.configJson) : null);
  if (
    instruction.kind !== "perps" ||
    instruction.action !== "open" ||
    instruction.exits.stopLossPrice === null
  ) {
    throw new ExecutionError("conflict", "Native protection has no reviewed opening instruction.");
  }
  const agent = manual ? null : await ownedAgent(db, entry.userId, entry.agentId),
    policy = manual?.policy ?? policySchema.parse(JSON.parse(agent?.policyJson ?? "null"));
  const market = await readHlMarket(instruction.market),
    mark = hlUnits(market.mark, 18),
    oldStop = checkpoint?.stop ?? instruction.exits.stopLossPrice;
  const trailing =
    instruction.exits.trailingStopBps === null
      ? { stop: oldStop, watermark: checkpoint?.watermark ?? market.mark }
      : tightenedPerpsStop(
          instruction.side,
          oldStop,
          checkpoint?.watermark ?? saved.market.mark,
          market.mark,
          instruction.exits.trailingStopBps,
          market.sizeDecimals,
        );
  if (quantity === 0n) {
    return { protected: true, ...trailing };
  }
  const open = await readHlOpenOrders(saved.address);
  const identities = await perpsOrderIdentities(db, entry, saved, checkpoint);
  if (open.some((order) => !identities.known.has(order.oid))) {
    throw new ExecutionError(
      "not_ready",
      "An unmanaged venue order needs review before updating protection.",
    );
  }
  const [latest] = await db
    .select()
    .from(executionEvents)
    .where(and(eq(executionEvents.actionId, entry.id), like(executionEvents.kind, "hl_signed_protect:%")))
    .orderBy(desc(executionEvents.createdAt))
    .limit(1);
  const lastIndex = latest ? Number(latest.kind.slice("hl_signed_protect:".length)) : -1;
  const previous = lastIndex < 0 ? null : await readHlRequest(db, entry, `protect:${lastIndex}`);
  const covered = open.find((order) => {
    const wire = identities.known.get(order.oid);
    return (
      wire &&
      "trigger" in wire.t &&
      wire.t.trigger.tpsl === "sl" &&
      order.reduceOnly &&
      order.isTrigger &&
      order.side === (instruction.side === "long" ? "A" : "B") &&
      hlUnits(order.triggerPx, 18) === hlUnits(wire.t.trigger.triggerPx, 18) &&
      hlUnits(order.origSz, market.sizeDecimals) >= quantity &&
      (instruction.side === "long"
        ? hlUnits(order.triggerPx, 18) >= hlUnits(trailing.stop, 18) && hlUnits(order.triggerPx, 18) < mark
        : hlUnits(order.triggerPx, 18) <= hlUnits(trailing.stop, 18) && hlUnits(order.triggerPx, 18) > mark)
    );
  });
  if (covered) {
    const coveringWire = identities.known.get(covered.oid);
    const group =
      previous?.action.type === "order" && previous.action.orders.some((wire) => wire.c === coveringWire?.c)
        ? previous.action
        : saved.action;
    if (group === previous?.action) {
      await recordConfirmedProtection(db, entry, lastIndex);
    }
    const retained = new Set(group.type === "order" ? group.orders.map((wire) => wire.c) : []);
    const cancels = open
      .flatMap((order) => {
        const wire = identities.known.get(order.oid);
        return wire?.c && !retained.has(wire.c) && wire.r ? [{ asset: market.asset, cloid: wire.c }] : [];
      })
      .slice(0, 3);
    if (cancels.length > 0) {
      await sendHlRequest(
        db,
        entry,
        "",
        `cancel:${Number.parseInt(executionHash(cancels).slice(0, 6), 16)}`,
        { type: "cancelByCloid", cancels },
        async (tx) => {
          const source = await ownedLedgerAction(tx, entry.userId, entry.id);
          if (entry.origin === "manual") {
            await manualPerpsContext(tx, source);
            return;
          }
          const activeAgent = await ownedAgent(tx, entry.userId, entry.agentId);
          if (activeAgent.status !== "running" || (await killSwitchEngaged(tx, entry.userId))) {
            throw new ExecutionError(
              "not_ready",
              "Protection changes stopped with the agent; existing native orders are retained.",
            );
          }
          await requireExecutionPermission(
            tx,
            entry.userId,
            defiPlanSchema.parse(JSON.parse(source.planJson)),
            await databaseTime(tx),
          );
        },
      );
    }
    return { protected: true, ...trailing };
  }
  if (previous?.action.type === "order") {
    const statuses = await Promise.allSettled(
      previous.action.orders.map(async (order) =>
        order.c ? readHlOrderStatus(saved.address, order.c) : null,
      ),
    );
    if (statuses.some((result) => result.status === "rejected")) {
      throw new ExecutionError(
        "not_ready",
        "Protective order status is unavailable; existing orders are retained.",
      );
    }
    if (
      previous.expiresAfter > Date.now() &&
      statuses.every((result) => result.status === "fulfilled" && result.value?.status !== "order")
    ) {
      return { protected: false, ...trailing };
    }
  }
  if (lastIndex - (await confirmedProtectionIndex(db, entry)) >= 3) {
    throw new ExecutionError(
      "not_ready",
      "Three protective submissions could not be confirmed. Check the venue position and retained native orders before restarting.",
    );
  }
  const crossed =
      instruction.side === "long" ? mark <= hlUnits(trailing.stop, 18) : mark >= hlUnits(trailing.stop, 18),
    index = lastIndex + 1;
  const requestRef = `${entry.requestId}:protection:${index}`;
  const close = agentInstructionSchema.parse({
    ...instruction,
    action: "close",
    quantity: hlText(quantity, market.sizeDecimals),
  });
  if (close.kind !== "perps") {
    throw new ExecutionError("conflict", "The protective reduction is not a Perps instruction.");
  }
  const wire = crossed
    ? composePerpsOrder(close, policy, market, requestRef, 0n, quantity).action
    : composePerpsProtection(instruction, market, requestRef, quantity, trailing.stop, policy.maxSlippageBps);
  await sendHlRequest(db, entry, "", `protect:${index}`, wire, async (tx) => {
    const source = await ownedLedgerAction(tx, entry.userId, entry.id),
      plan = defiPlanSchema.parse(JSON.parse(source.planJson));
    const activeAgent = entry.origin === "manual" ? null : await ownedAgent(tx, entry.userId, entry.agentId);
    if (activeAgent && (activeAgent.status !== "running" || (await killSwitchEngaged(tx, entry.userId)))) {
      throw new ExecutionError(
        "not_ready",
        "Protection updates stopped with the agent. Existing native orders remain active.",
      );
    }
    if (entry.origin === "manual") {
      await manualPerpsContext(tx, source);
    } else {
      await requireExecutionPermission(tx, entry.userId, plan, await databaseTime(tx));
    }
    const rows = await tx
      .select()
      .from(defiPositions)
      .where(
        and(
          eq(defiPositions.userId, entry.userId),
          eq(defiPositions.agentId, entry.agentId),
          eq(defiPositions.instrumentId, perpsInstrumentId(saved.address, instruction.market)),
        ),
      );
    const held = rows.find((row) => row.kind === (instruction.side === "long" ? "perp_long" : "perp_short"));
    const allowed =
      source.status === "settled"
        ? (held?.quantityUnits ?? 0n)
        : ["submitting", "submitted", "unknown"].includes(source.status)
          ? BigInt(saved.requestedUnits)
          : 0n;
    if (
      quantity > allowed ||
      market.asset !== saved.market.asset ||
      market.sizeDecimals !== saved.market.sizeDecimals
    ) {
      throw new ExecutionError(
        "not_ready",
        "The protective order exceeds the agent's verified owned exposure.",
      );
    }
    const [last] = await tx
      .select()
      .from(executionEvents)
      .where(and(eq(executionEvents.actionId, entry.id), like(executionEvents.kind, "hl_signed_protect:%")))
      .orderBy(desc(executionEvents.createdAt))
      .limit(1);
    if ((last?.id ?? null) !== (latest?.id ?? null)) {
      throw new ExecutionError("conflict", "Another worker updated this position's protection.");
    }
  });
  return { protected: false, ...trailing };
}
