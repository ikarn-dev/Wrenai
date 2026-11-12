import "server-only";
import { createHash, sign } from "node:crypto";
import { KeyType, PublicKey } from "@near-js/crypto";
import { actionCreators, createTransaction, Signature, SignedTransaction } from "@near-js/transactions";
import { base58 } from "@scure/base";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { ed25519KeyFromSeed, ed25519PublicKey } from "@/server/near/ed25519-key";
import { maximumUnits } from "@/shared/token-units";
import { TestnetError, testnetCipher, testnetEnv } from "./config";
import type { TestnetDatabase } from "./database";
import { locatedBalance, publicIntentsTransfer } from "./intents";
import { openPlan, ownedOrder } from "./orders";
import { GAS_CAP, poolTransaction } from "./pool";
import { testnetBalance, testnetChain, testnetRpc } from "./rpc";
import { tnAgents, tnBalances, tnOrders, tnOwners, tnSubmissions } from "./schema";
export async function signPoolStage(
  db: TestnetDatabase,
  id: string,
): Promise<{ hash: string; bytes: string } | null> {
  await testnetChain();
  const [review] = await db.select().from(tnOrders).where(eq(tnOrders.id, id));
  if (!review?.confirmedAt || !["queued", "prepared"].includes(review.state)) {
    return null;
  }
  const actualInput = await locatedBalance(
    testnetEnv().TESTNET_POOL_ACCOUNT_ID,
    review.assetId,
    review.location,
  );
  if (review.location === "intents") {
    const call = openPlan(review).calls[review.step];
    if (call?.method === "mt_transfer") {
      await publicIntentsTransfer(
        openPlan(review).signer,
        review.assetId,
        review.inputUnits,
        String(call.args["receiver_id"]),
      );
    }
  }
  const env = testnetEnv(),
    seed = Buffer.from(env.TESTNET_POOL_SEED, "base64"),
    key = ed25519KeyFromSeed(seed);
  seed.fill(0);
  const publicKey = ed25519PublicKey(key);
  const access = z
    .object({ nonce: z.string().regex(/^\d+$/), permission: z.literal("FullAccess"), block_hash: z.string() })
    .parse(
      await testnetRpc("query", {
        request_type: "view_access_key",
        account_id: env.TESTNET_POOL_ACCOUNT_ID,
        public_key: publicKey,
        finality: "final",
      }),
    );
  const native = await testnetBalance(env.TESTNET_POOL_ACCOUNT_ID, "native:near"),
    gas = z
      .object({ gas_price: z.string() })
      .parse(await testnetRpc("gas_price", { block_id: access.block_hash }));
  return poolTransaction(db, async (tx) => {
    const [row] = await tx.select().from(tnOrders).where(eq(tnOrders.id, id));
    if (!row?.confirmedAt || !["queued", "prepared"].includes(row.state)) {
      return null;
    }
    const [owner] = await tx.select().from(tnOwners).where(eq(tnOwners.id, row.ownerId));
    if (owner?.kind !== "guest" || owner.expiresAt <= Date.now()) {
      throw new TestnetError("unauthorized", "Guest signing authority expired.");
    }
    const [prior] = await tx
      .select()
      .from(tnSubmissions)
      .where(and(eq(tnSubmissions.orderId, id), eq(tnSubmissions.step, row.step)));
    if (prior) {
      return null;
    }
    const [active] = await tx
      .select({ id: tnOrders.id })
      .from(tnOrders)
      .innerJoin(tnOwners, eq(tnOrders.ownerId, tnOwners.id))
      .where(
        and(
          eq(tnOwners.kind, "guest"),
          inArray(tnOrders.state, ["prepared", "submitted", "needs_review"]),
          ne(tnOrders.id, id),
        ),
      )
      .limit(1);
    if (active) {
      return null;
    }
    if (row.bucket !== "manual") {
      const [agent] = await tx
        .select()
        .from(tnAgents)
        .where(and(eq(tnAgents.id, row.bucket), eq(tnAgents.ownerId, row.ownerId)));
      if (!agent || agent.state === "stopped" || agent.state === "blocked" || agent.expiresAt <= Date.now()) {
        throw new TestnetError("unauthorized", "Agent authorization stopped before signing.");
      }
    }
    const plan = openPlan(row),
      call = plan.calls[row.step];
    if (!call || plan.signer !== env.TESTNET_POOL_ACCOUNT_ID) {
      throw new TestnetError("conflict", "The reviewed executor does not match the pool.");
    }
    if (
      (row.step === 0 && row.expiresAt <= Date.now()) ||
      (plan.quote && Date.parse(plan.quote.quoteRequest.deadline) <= Date.now())
    ) {
      throw new TestnetError("conflict", "This quote expired before submission.");
    }
    const [{ backing } = { backing: "0" }] = await tx
      .select({ backing: sql<string>`coalesce(sum(${tnBalances.units}::numeric),0)::text` })
      .from(tnBalances)
      .where(and(eq(tnBalances.assetId, row.assetId), eq(tnBalances.location, row.location)));
    if (actualInput < BigInt(backing)) {
      throw new TestnetError("limit", "The selected pool balance no longer backs its allocations.");
    }
    const [{ allocated } = { allocated: "0" }] = await tx
      .select({ allocated: sql<string>`coalesce(sum(${tnBalances.units}::numeric),0)::text` })
      .from(tnBalances)
      .innerJoin(tnOwners, eq(tnBalances.ownerId, tnOwners.id))
      .where(and(eq(tnBalances.assetId, "native:near"), eq(tnOwners.kind, "guest")));
    const finalized = await tx.select().from(tnSubmissions).where(eq(tnSubmissions.orderId, id));
    const paid = finalized
      .filter((s) => s.finalizedAt !== null)
      .reduce(
        (n, s) =>
          n +
          BigInt(
            z.object({ feeUnits: z.string().regex(/^\d+$/) }).parse(JSON.parse(s.outcome ?? "{}")).feeUnits,
          ),
        0n,
      );
    const prepaid =
        plan.calls.slice(row.step).reduce((n, c) => n + BigInt(c.gas), 0n) * BigInt(gas.gas_price),
      storage = call.method === null && row.assetId === "native:near" ? 0n : BigInt(call.deposit);
    if (paid + prepaid > GAS_CAP || native < BigInt(allocated) + env.reserve + prepaid + storage) {
      throw new TestnetError("limit", "The protected pool gas reserve is too low.");
    }
    const [last] = await tx
      .select()
      .from(tnSubmissions)
      .orderBy(desc(sql`${tnSubmissions.nonce}::numeric`))
      .limit(1);
    const chain = BigInt(access.nonce),
      previous = BigInt(last?.nonce ?? "0"),
      nonce = maximumUnits(chain, previous) + 1n;
    const actions =
      call.method === null
        ? [actionCreators.transfer(BigInt(call.deposit))]
        : [actionCreators.functionCall(call.method, call.args, BigInt(call.gas), BigInt(call.deposit))];
    const transaction = createTransaction(
        env.TESTNET_POOL_ACCOUNT_ID,
        PublicKey.fromString(publicKey),
        call.receiverId,
        nonce,
        actions,
        base58.decode(access.block_hash),
      ),
      hash = createHash("sha256").update(transaction.encode()).digest(),
      bytes = Buffer.from(
        new SignedTransaction({
          transaction,
          signature: new Signature({ keyType: KeyType.ED25519, data: new Uint8Array(sign(null, hash, key)) }),
        }).encode(),
      ).toString("base64"),
      encoded = base58.encode(hash);
    await tx.insert(tnSubmissions).values({
      orderId: id,
      step: row.step,
      nonce: nonce.toString(),
      hash: encoded,
      sealedBytes: testnetCipher().seal(row.ownerId, id, `signed:${row.step}`, bytes),
      createdAt: Date.now(),
    });
    await tx.update(tnOrders).set({ state: "prepared", txHash: encoded }).where(eq(tnOrders.id, id));
    return { hash: encoded, bytes };
  });
}
export async function attachWalletReceipt(
  db: TestnetDatabase,
  owner: string,
  id: string,
  hash: string,
): Promise<void> {
  await poolTransaction(db, async (tx) => {
    const row = await ownedOrder(tx, owner, id),
      [person] = await tx.select().from(tnOwners).where(eq(tnOwners.id, owner));
    if (person?.kind !== "wallet" || !row.confirmedAt) {
      throw new TestnetError("unauthorized", "Confirm this wallet order first.");
    }
    if (row.txHash && row.txHash !== hash) {
      throw new TestnetError("conflict", "This stage already has a transaction receipt.");
    }
    await tx
      .insert(tnSubmissions)
      .values({ orderId: id, step: row.step, nonce: "0", hash, sealedBytes: "", createdAt: Date.now() })
      .onConflictDoNothing();
    const [claimed] = await tx.select().from(tnSubmissions).where(eq(tnSubmissions.hash, hash));
    if (claimed?.orderId !== id || claimed.step !== row.step) {
      throw new TestnetError("conflict", "This receipt belongs to a different order.");
    }
    await tx.update(tnOrders).set({ txHash: hash, state: "submitted" }).where(eq(tnOrders.id, id));
  });
}
