import "server-only";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { walletActivityPage } from "@/server/activity/wallet";
import { agentEvents, agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "@/server/execution/contracts";
import { decimal } from "@/server/research/decimal";
import type { ActivityEntry } from "@/shared/activity";
import type { AgentInstruction } from "@/shared/agent-instructions";
import { assetUsdPrice } from "./instruction-price";
import type { StrategyCheckPlan } from "./planning";
import { type WhaleState, whaleStateSchema } from "./whale-state";

type WhaleInstruction = Extract<AgentInstruction, { kind: "whale_tracker" }>;
function eventId(agentId: string, account: string, event: ActivityEntry): string {
  return createHash("sha256")
    .update(JSON.stringify(["whale-alert:v1", agentId, account, event.id]))
    .digest("hex");
}
export async function whaleThresholdMatches(
  instruction: WhaleInstruction,
  event: ActivityEntry,
): Promise<boolean> {
  const amount = event.amount;
  if (
    (event.status !== "completed" && event.status !== "recorded") ||
    amount?.kind !== "token" ||
    !amount.assetId ||
    amount.direction === "none" ||
    BigInt(amount.units) === 0n
  ) {
    return false;
  }
  if (
    instruction.assetIds.length > 0 &&
    amount.assetId !== "native:near" &&
    !instruction.assetIds.includes(amount.assetId)
  ) {
    return false;
  }
  if (
    instruction.assetIds.length > 0 &&
    amount.assetId === "native:near" &&
    !instruction.assetIds.includes("nep141:wrap.near")
  ) {
    return false;
  }
  const threshold = instruction.threshold;
  if (threshold.type === "token") {
    return amount.assetId === threshold.assetId && BigInt(amount.units) >= BigInt(threshold.amountUnits);
  }
  if (amount.decimals === null) {
    throw new ExecutionError(
      "not_ready",
      "A watched transfer has no verified token precision for its USD threshold.",
    );
  }
  const price = await assetUsdPrice(amount.assetId),
    limit = decimal(threshold.amountUsd);
  return BigInt(amount.units) * price.n * limit.d >= limit.n * price.d * 10n ** BigInt(amount.decimals);
}

export async function planWhaleCheck(
  db: AppDatabase,
  runtime: typeof agentRuntimes.$inferSelect,
  instruction: WhaleInstruction,
): Promise<StrategyCheckPlan> {
  const now = Date.now();
  const state: WhaleState = runtime.strategyStateJson
    ? whaleStateSchema.parse(JSON.parse(runtime.strategyStateJson))
    : {
        format: 4,
        kind: "whale_tracker",
        phase: "watching",
        cursors: instruction.accounts.flatMap((account) =>
          instruction.events.map((event) => ({
            account,
            stream: event === "native_transfer" ? ("transactions" as const) : ("tokens" as const),
            from: runtime.createdAt,
            snapshotAt: now,
            next: null,
            lastAlertAt: 0,
          })),
        ),
      };
  if (now >= Date.parse(instruction.expiresAt)) {
    return {
      signal: null,
      intervalSeconds: 60,
      reason: "The reviewed watch period is complete.",
      progress: { strategyState: { ...state, phase: "completed" }, completed: true },
    };
  }
  const expected = instruction.accounts.length * instruction.events.length;
  if (
    state.cursors.length !== expected ||
    state.cursors.some((cursor) => !instruction.accounts.includes(cursor.account))
  ) {
    throw new ExecutionError("conflict", "The watch cursor does not belong to this reviewed watchlist.");
  }
  const cursors = [...state.cursors];
  const alerts: {
    readonly id: string;
    readonly event: ActivityEntry;
    readonly account: string;
    readonly notify: boolean;
  }[] = [];
  // Bounded parallelism keeps provider usage predictable. Pagination resumes across durable polls.
  for (let offset = 0; offset < cursors.length; offset += 4) {
    const readings = await Promise.all(
      cursors.slice(offset, offset + 4).map(async (cursor) => {
        const page = await walletActivityPage(
          cursor.account,
          cursor.stream,
          { next: cursor.next, offset: 0, done: false, unavailable: false },
          cursor.snapshotAt,
        );
        const ids = page.items.map((event) => eventId(runtime.agentId, cursor.account, event));
        const known = new Set(
          ids.length
            ? (
                await db
                  .select({ id: agentEvents.id })
                  .from(agentEvents)
                  .where(and(eq(agentEvents.userId, runtime.userId), inArray(agentEvents.id, ids)))
                  .limit(20)
              ).map((row) => row.id)
            : [],
        );
        let lastAlertAt = cursor.lastAlertAt;
        for (const event of page.items) {
          if (
            known.has(eventId(runtime.agentId, cursor.account, event)) ||
            event.occurredAt < cursor.from ||
            !(await whaleThresholdMatches(instruction, event))
          ) {
            continue;
          }
          const notify = now - lastAlertAt >= instruction.cooldownSeconds * 1000;
          alerts.push({
            id: eventId(runtime.agentId, cursor.account, event),
            event,
            account: cursor.account,
            notify,
          });
          if (notify) {
            lastAlertAt = now;
          }
        }
        const complete = page.next === null || page.items.some((event) => event.occurredAt < cursor.from);
        return complete
          ? {
              ...cursor,
              from: Math.max(runtime.createdAt, cursor.snapshotAt - 300_000),
              snapshotAt: now,
              next: null,
              lastAlertAt,
            }
          : { ...cursor, next: page.next, lastAlertAt };
      }),
    );
    readings.forEach((reading, index) => {
      cursors[offset + index] = reading;
    });
  }
  await userTransaction(db, runtime.userId, async (tx) => {
    const [row] = await tx
      .select()
      .from(agentRuntimes)
      .where(and(eq(agentRuntimes.agentId, runtime.agentId), eq(agentRuntimes.userId, runtime.userId)))
      .limit(1);
    if (
      row?.state !== "active" ||
      row.strategyVersion !== runtime.strategyVersion ||
      row.leaseToken !== runtime.leaseToken
    ) {
      throw new ExecutionError("lease_lost", "The watchlist changed during this check.");
    }
    for (const alert of alerts) {
      await tx
        .insert(agentEvents)
        .values({
          id: alert.id,
          userId: runtime.userId,
          agentId: runtime.agentId,
          kind: "whale_alert",
          message: `Watched account ${alert.account}: ${alert.event.title}. ${alert.event.description}`.slice(
            0,
            500,
          ),
          detailJson: JSON.stringify({
            format: 1,
            account: alert.account,
            eventId: alert.event.id,
            occurredAt: alert.event.occurredAt,
            transactionHash: alert.event.transactionHash,
            amount: alert.event.amount,
            notificationEligible: alert.notify,
            evidence: "public_indexer",
            coverage: "explicit_watchlist",
          }),
          createdAt: now,
        })
        .onConflictDoNothing({ target: agentEvents.id });
    }
  });
  return {
    signal: null,
    intervalSeconds: 60,
    reason: "Watching indexed transfers for the reviewed accounts; alerts appear in Activity.",
    progress: { strategyState: { ...state, cursors }, completed: false },
  };
}
