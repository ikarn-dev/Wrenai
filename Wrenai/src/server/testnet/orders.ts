import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { intentUnits, type TestnetIntent, testnetAsset, testnetIntentSchema } from "@/shared/testnet";
import { TestnetError, testnetCipher, testnetEnv } from "./config";
import type { TestnetDatabase } from "./database";
import { locatedBalance, publicIntentsTransfer } from "./intents";
import {
  actionCapacity,
  changeBalance,
  GAS_CAP,
  ownedBalance,
  poolTransaction,
  type TestnetOwner,
} from "./pool";
import { testnetQuote, tideQuoteSchema } from "./provider";
import { callSchema, testnetBalance, testnetChain, tokenRegistration, transferCalls } from "./rpc";
import { tnOrders } from "./schema";
export const planSchema = z.object({
  intent: testnetIntentSchema,
  calls: z.array(callSchema).max(4),
  quote: tideQuoteSchema.nullable(),
  signer: z.string(),
});
export type TestnetPlan = z.infer<typeof planSchema>;
export type TestnetOrder = typeof tnOrders.$inferSelect;
export function openPlan(order: TestnetOrder): TestnetPlan {
  return planSchema.parse(
    JSON.parse(testnetCipher().open(order.ownerId, order.id, "plan", order.sealedPlan)),
  );
}
export async function ownedOrder(db: TestnetDatabase, owner: string, id: string): Promise<TestnetOrder> {
  const [row] = await db
    .select()
    .from(tnOrders)
    .where(and(eq(tnOrders.id, id), eq(tnOrders.ownerId, owner)));
  if (!row) {
    throw new TestnetError("unauthorized", "This order is not available to this session.");
  }
  return row;
}
export async function quoteTestnetOrder(
  db: TestnetDatabase,
  owner: TestnetOwner,
  requestId: string,
  intent: TestnetIntent,
  bucket = "manual",
): Promise<TestnetOrder> {
  const [prior] = await db
    .select()
    .from(tnOrders)
    .where(and(eq(tnOrders.ownerId, owner.id), eq(tnOrders.requestId, requestId)));
  if (prior) {
    if (JSON.stringify(openPlan(prior).intent) !== JSON.stringify(intent)) {
      throw new TestnetError("conflict", "This request ID belongs to another order.");
    }
    return prior;
  }
  if (intent.kind === "payment") {
    await testnetChain();
  }
  const location = intent.location ?? "wallet",
    outputLocation = intent.kind === "swap" ? (intent.outputLocation ?? location) : location,
    units = intentUnits(intent).toString(),
    signer = owner.kind === "guest" ? testnetEnv().TESTNET_POOL_ACCOUNT_ID : owner.accountId;
  if (!signer) {
    throw new TestnetError("unauthorized", "Reconnect your testnet wallet.");
  }
  const available =
    owner.kind === "guest" ? await ownedBalance(db, owner.id, intent.assetId, bucket, location) : null;
  if (available && BigInt(available.units) - BigInt(available.held) < BigInt(units)) {
    throw new TestnetError("limit", "This amount exceeds your available testnet allocation.");
  }
  const held = await locatedBalance(signer, intent.assetId, location);
  if (held < BigInt(units)) {
    throw new TestnetError("limit", "The selected testnet balance is insufficient.");
  }
  const id = randomUUID();
  let quote: TestnetPlan["quote"] = null,
    calls: TestnetPlan["calls"];
  if (intent.kind === "swap") {
    quote = await testnetQuote(
      intent.assetId,
      intent.outputAssetId,
      units,
      signer,
      intent.slippageBps,
      false,
      location,
      outputLocation,
    );
    const target = quote.quote.depositAddress;
    if (!target) {
      throw new TestnetError("unavailable", "A verified deposit address was not returned.");
    }
    const output = testnetAsset(intent.outputAssetId);
    if (!output.contract) {
      throw new TestnetError("invalid_input", "This route cannot pay native NEAR.");
    }
    calls = [
      ...(outputLocation === "wallet" ? await tokenRegistration(output.contract, signer) : []),
      ...(location === "intents"
        ? [await publicIntentsTransfer(signer, intent.assetId, units, target)]
        : await transferCalls(intent.assetId, units, target)),
    ];
  } else {
    calls =
      location === "intents"
        ? [await publicIntentsTransfer(signer, intent.assetId, units, intent.recipient)]
        : await transferCalls(intent.assetId, units, intent.recipient);
  }
  const plan: TestnetPlan = { intent, calls, quote, signer },
    now = Date.now();
  const [row] = await db
    .insert(tnOrders)
    .values({
      id,
      ownerId: owner.id,
      requestId,
      bucket,
      kind: intent.kind,
      state: "review",
      assetId: intent.assetId,
      inputUnits: units,
      location,
      outputLocation,
      outputAssetId: intent.kind === "swap" ? intent.outputAssetId : null,
      outputUnits: null,
      recipient: intent.kind === "payment" ? intent.recipient : signer,
      expiresAt: quote ? Math.min(Date.parse(quote.quoteRequest.deadline), now + 15000) : now + 60000,
      createdAt: now,
      depositAddress: quote?.quote.depositAddress ?? null,
      sealedPlan: testnetCipher().seal(owner.id, id, "plan", JSON.stringify(plan)),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    return ownedOrder(
      db,
      owner.id,
      (
        await db
          .select()
          .from(tnOrders)
          .where(and(eq(tnOrders.ownerId, owner.id), eq(tnOrders.requestId, requestId)))
      )[0]?.id ?? "",
    );
  }
  return row;
}
export async function confirmTestnetOrder(
  db: TestnetDatabase,
  owner: TestnetOwner,
  id: string,
): Promise<TestnetOrder> {
  const saved = await ownedOrder(db, owner.id, id);
  if (saved.confirmedAt) {
    return saved;
  }
  const [native, input] = await Promise.all([
    testnetBalance(openPlan(saved).signer, "native:near"),
    locatedBalance(openPlan(saved).signer, saved.assetId, saved.location),
  ]);
  if (input < BigInt(saved.inputUnits)) {
    throw new TestnetError("limit", "The selected testnet balance is insufficient.");
  }
  return poolTransaction(db, async (tx) => {
    const order = await ownedOrder(tx, owner.id, id);
    if (order.confirmedAt) {
      return order;
    }
    if (order.state !== "review" || order.expiresAt <= Date.now() || owner.expiresAt <= Date.now()) {
      throw new TestnetError("conflict", "The review expired. Request a fresh quote.");
    }
    const plan = openPlan(order),
      deposits = plan.calls.reduce((n, c) => n + BigInt(c.deposit), 0n);
    if (owner.kind === "guest") {
      await actionCapacity(tx, owner, order.assetId, BigInt(order.inputUnits));
      const others = await tx.select().from(tnOrders).where(eq(tnOrders.ownerId, owner.id));
      const spent = others
          .filter(
            (o) => o.confirmedAt !== null && o.confirmedAt >= owner.createdAt && o.assetId === order.assetId,
          )
          .reduce((n, o) => n + BigInt(o.inputUnits), 0n),
        cap = testnetEnv().allowances.find((a) => a.assetId === order.assetId)?.cap;
      if (
        cap === undefined ||
        spent + BigInt(order.inputUnits) > cap * BigInt(testnetEnv().TESTNET_MAX_ACTIONS_PER_GUEST)
      ) {
        throw new TestnetError("limit", "This asset's session turnover cap is reached.");
      }
      const all = await tx.select().from(tnOrders).where(eq(tnOrders.state, "queued"));
      if (native < testnetEnv().reserve + GAS_CAP * BigInt(all.length + 1) + deposits) {
        throw new TestnetError("limit", "The guest pool is protecting its gas reserve.");
      }
      await changeBalance(
        tx,
        owner.id,
        order.assetId,
        0n,
        BigInt(order.inputUnits),
        order.bucket,
        order.location,
      );
    } else if (native < GAS_CAP + deposits) {
      throw new TestnetError("limit", "Keep enough native test NEAR for storage and gas.");
    }
    const [result] = await tx
      .update(tnOrders)
      .set({ state: "queued", confirmedAt: Date.now() })
      .where(eq(tnOrders.id, id))
      .returning();
    if (!result) {
      throw new TestnetError("unavailable", "Could not confirm this order.");
    }
    return result;
  });
}
export async function testnetOrders(db: TestnetDatabase, owner: string): Promise<TestnetOrder[]> {
  return db
    .select()
    .from(tnOrders)
    .where(eq(tnOrders.ownerId, owner))
    .orderBy(desc(tnOrders.createdAt))
    .limit(50);
}
