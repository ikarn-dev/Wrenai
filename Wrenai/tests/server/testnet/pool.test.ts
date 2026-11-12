import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { testnetEnv } from "@/server/testnet/config";
import { rejectUnsignedOrder } from "@/server/testnet/execution";
import { ownedOrder } from "@/server/testnet/orders";
import {
  actionCapacity,
  changeBalance,
  grantGuest,
  ownedBalance,
  poolTransaction,
} from "@/server/testnet/pool";
import { tnBalances, tnOrders, tnSubmissions } from "@/server/testnet/schema";
import { queuedPayment, testnetContext, USDC, USDT } from "./context";

let context: Awaited<ReturnType<typeof testnetContext>>;
describe("testnet shared pool", () => {
  beforeEach(async () => {
    context = await testnetContext();
  });
  afterEach(async () => {
    await context.postgres.close();
    vi.unstubAllEnvs();
  });
  it("migrates separate tables without changing mainnet history and denies client access", async () => {
    const tables = await context.postgres.query<{
      tablename: string;
      rowsecurity: boolean;
      granted: boolean;
    }>(
      `select tablename,rowsecurity,has_table_privilege('anon',format('public.%I',tablename),'SELECT,INSERT,UPDATE,DELETE') as granted from pg_tables where schemaname='public'`,
    );
    expect(tables.rows).toHaveLength(11);
    expect(tables.rows.every((r) => r.rowsecurity && !r.granted)).toBe(true);
    const history = await context.postgres.query<{ hash: string }>(
      "select hash from drizzle.__drizzle_migrations",
    );
    expect(history.rows).toEqual([{ hash: "mainnet-marker" }]);
    const testnetHistory = await context.postgres.query(
      "select id from drizzle_testnet.__drizzle_migrations",
    );
    expect(testnetHistory.rows).toHaveLength(3);
  });
  it("grants only available units, keeping protected gas inventory", async () => {
    const { db, owner } = context;
    await poolTransaction(db, (tx) =>
      grantGuest(
        tx,
        owner,
        new Map([
          [USDC, 10000000n],
          [USDT, 10000000n],
          ["native:near", 3n * 10n ** 24n],
        ]),
        0,
      ),
    );
    expect((await ownedBalance(db, owner.id, USDC)).units).toBe("5000000");
    expect((await ownedBalance(db, context.stranger.id, USDC)).units).toBe("0");
  });
  it("rolls back an underfunded grant instead of allocating nonexistent tokens", async () => {
    const { db, owner } = context;
    await expect(
      poolTransaction(db, (tx) =>
        grantGuest(
          tx,
          owner,
          new Map([
            [USDC, 1n],
            ["native:near", 3n * 10n ** 24n],
          ]),
          0,
        ),
      ),
    ).rejects.toMatchObject({ code: "funding_required" });
    expect(await db.select().from(tnBalances)).toHaveLength(0);
  });
  it("rejects native gas depletion even when token inventory is sufficient", async () => {
    await expect(
      poolTransaction(context.db, (tx) =>
        grantGuest(
          tx,
          context.owner,
          new Map([
            [USDC, 100000000n],
            ["native:near", 1n],
          ]),
          0,
        ),
      ),
    ).rejects.toThrow("native NEAR");
  });
  it("prevents overspending and cannot release a different owner's balance", async () => {
    const { db, owner, stranger } = context;
    await poolTransaction(db, async (tx) => {
      await changeBalance(tx, owner.id, USDC, 2000000n, 0n);
      await changeBalance(tx, owner.id, USDC, 0n, 1500000n);
    });
    await expect(poolTransaction(db, (tx) => changeBalance(tx, owner.id, USDC, 0n, 600000n))).rejects.toThrow(
      "allocation",
    );
    expect((await ownedBalance(db, stranger.id, USDC)).units).toBe("0");
    expect((await ownedBalance(db, owner.id, USDC)).held).toBe("1500000");
  });
  it("splits one guest grant across locations without doubling it or borrowing another location's backing", async () => {
    const { db, owner } = context;
    const actual = new Map([
      ["native:near", 4n * 10n ** 24n],
      [USDC, 2000000n],
      [`intents:${USDC}`, 3000000n],
      [`intents:${USDT}`, 10000000n],
    ]);
    await poolTransaction(db, (tx) => grantGuest(tx, owner, actual, 0));
    expect((await ownedBalance(db, owner.id, USDC)).units).toBe("2000000");
    expect((await ownedBalance(db, owner.id, USDC, "manual", "intents")).units).toBe("3000000");
    expect((await ownedBalance(db, owner.id, USDT, "manual", "intents")).units).toBe("5000000");
    await expect(
      poolTransaction(db, (tx) => changeBalance(tx, owner.id, USDC, 0n, 2500000n)),
    ).rejects.toThrow("allocation");
    await poolTransaction(db, (tx) => changeBalance(tx, owner.id, USDC, 0n, 2500000n, "manual", "intents"));
    expect((await ownedBalance(db, owner.id, USDC)).held).toBe("0");
  });
  it("rejects invalid or native-NEAR Intents ledger locations at the database boundary", async () => {
    await expect(
      context.postgres.query(
        "INSERT INTO testnet_balances (owner_id,bucket,asset_id,location,units,held) VALUES ($1,'manual','native:near','intents','1','0')",
        [context.owner.id],
      ),
    ).rejects.toThrow();
  });
  it("enforces per-action and nonrenewing action-count caps", async () => {
    const { db, owner } = context;
    await expect(actionCapacity(db, owner, USDC, 1000001n)).rejects.toThrow("per-action");
    for (let i = 0; i < testnetEnv().TESTNET_MAX_ACTIONS_PER_GUEST; i++) {
      await queuedPayment(db, owner);
    }
    await expect(actionCapacity(db, owner, USDC, 1n)).rejects.toThrow("action limit");
  });
  it("does not expose another session's exact order", async () => {
    const order = await queuedPayment(context.db, context.owner);
    await expect(ownedOrder(context.db, context.stranger.id, order.id)).rejects.toThrow("session");
  });
  it("releases an unsigned reservation without allowing a duplicate refund", async () => {
    const { db, owner } = context;
    await poolTransaction(db, (tx) => changeBalance(tx, owner.id, USDC, 2000000n, 1000000n));
    const order = await queuedPayment(db, owner);
    await rejectUnsignedOrder(db, order.id, "Expired before signing.");
    await rejectUnsignedOrder(db, order.id, "Expired again.");
    const b = await ownedBalance(db, owner.id, USDC);
    expect(b.units).toBe("2000000");
    expect(b.held).toBe("0");
    expect((await ownedOrder(db, owner.id, order.id)).state).toBe("failed");
  });
  it("retains held funds after an ambiguous signed submission", async () => {
    const { db, owner } = context;
    await poolTransaction(db, (tx) => changeBalance(tx, owner.id, USDC, 2000000n, 1000000n));
    const order = await queuedPayment(db, owner);
    await db.insert(tnSubmissions).values({
      orderId: order.id,
      step: 0,
      nonce: "9007199254740999",
      hash: "test-hash",
      sealedBytes: "sealed",
      createdAt: Date.now(),
    });
    await db.update(tnOrders).set({ state: "prepared" }).where(eq(tnOrders.id, order.id));
    await rejectUnsignedOrder(db, order.id, "Submission unknown.");
    expect((await ownedBalance(db, owner.id, USDC)).held).toBe("1000000");
    expect((await ownedOrder(db, owner.id, order.id)).state).toBe("needs_review");
  });
});
