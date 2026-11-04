import { createHash, createSecretKey } from "node:crypto";
import { decodeSignedTransaction, encodeTransaction } from "@near-js/transactions";
import { base58 } from "@scure/base";
import {
  nativeBlock,
  nativeOutcomeFixture,
  nativePreparedFixture,
} from "@tests/server/execution/rhea/proof-fixture";
import { manualContext } from "@tests/server/manual-trading/context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executionActions, executionFills } from "@/server/db/execution-schema";
import { nativeSubmissions } from "@/server/db/native-schema";
import { tradingAccounts } from "@/server/db/trading-account-schema";
import { advanceLedgerAction } from "@/server/engine/ledger-action";
import { beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import { executionHash } from "@/server/execution/records";
import { type RheaPrepared, rheaSwapCall } from "@/server/execution/rhea/contracts";
import { confirmManualTrade, quoteManualTrade } from "@/server/manual-trading/service";
import { ensureTradingAccount, tradingAccountSigningKeys } from "@/server/trading-accounts/vault";

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 9)) }),
}));
vi.mock("@/server/intents/verifier", () => ({
  readKeyRegistration: async () => ({ registered: true, blockHeight: 2 }),
}));
const provider = vi.hoisted(() => ({
  quote: vi.fn(),
  order: vi.fn(),
  metadata: vi.fn(),
  sync: vi.fn(),
  broadcast: vi.fn(),
  outcome: vi.fn(),
  balance: vi.fn(),
}));
vi.mock("@/server/execution/rhea/quote", async (original) => ({
  ...(await original<typeof import("@/server/execution/rhea/quote")>()),
  quoteRhea: provider.quote,
  readDclPairPool: async () => "raw.nearlytrade.near|wrap.near|2000",
}));
vi.mock("@/server/execution/rhea/order", async (original) => ({
  ...(await original<typeof import("@/server/execution/rhea/order")>()),
  prepareRheaOrder: provider.order,
}));
vi.mock("@/server/execution/rhea/inventory", () => ({
  synchronizeNativeInventory: provider.sync,
  nativeTokenAsset: provider.metadata,
}));
vi.mock("@/server/execution/rhea/rpc", () => ({
  nativeSigningState: async () => ({
    nonce: 10000000000000000n,
    blockHash: nativeBlock,
    gasPrice: 100000000n,
    observedAt: Date.now(),
  }),
  nativeRpc: provider.broadcast,
}));
vi.mock("@/server/near/rpc", () => ({
  callViewFunction: provider.balance,
  viewNearBudgetBalance: async () => ({ balance: 10n ** 24n, spendable: 10n ** 24n, blockHeight: 12 }),
  readFinalTransaction: provider.outcome,
  finalBlockTime: async () => 1793700000000,
}));
let context: Awaited<ReturnType<typeof manualContext>>,
  prepared: RheaPrepared,
  sent: Uint8Array | null,
  filled: boolean;
beforeEach(async () => {
  context = await manualContext();
  sent = null;
  filled = false;
  const root = await ensureTradingAccount(context.db, "owner");
  await context.db
    .update(tradingAccounts)
    .set({ backupConfirmedAt: Date.now(), backupFileHash: "a".repeat(64), backupVersion: 2 })
    .where(eq(tradingAccounts.id, root.id));
  const fixture = nativePreparedFixture();
  prepared = { ...fixture, rootId: root.id, accountId: root.nativeAccountId };
  prepared = {
    ...prepared,
    payloadHash: executionHash({
      swap: rheaSwapCall(prepared),
      registrationDeposit: null,
      accountId: prepared.accountId,
    }),
  };
  provider.balance.mockReset().mockResolvedValue({ value: "1000" });
  provider.quote.mockReset().mockImplementation(async () => ({ ...prepared.quote, observedAt: Date.now() }));
  provider.order.mockReset().mockImplementation(async () => prepared);
  provider.metadata
    .mockReset()
    .mockImplementation(async (id: string) =>
      id === prepared.quote.input.assetId ? prepared.quote.input : prepared.quote.output,
    );
  provider.sync.mockReset().mockImplementation(async () => {
    const syncToken = await beginInventorySync(context.db, "owner", "native_near");
    await finishInventorySync(context.db, "owner", {
      scope: "native_near",
      syncToken,
      balances: [
        { assetId: prepared.quote.input.assetId, amountUnits: filled ? "900" : "1000" },
        { assetId: prepared.quote.output.assetId, amountUnits: filled ? "200" : "0" },
        { assetId: "native:near", amountUnits: (10n ** 24n).toString() },
      ],
    });
  });
  provider.broadcast.mockReset().mockImplementation(async (_method: string, raw: unknown) => {
    const args = Array.isArray(raw) ? raw : [];
    if (typeof args[0] !== "string") {
      throw new Error("Missing bytes");
    }
    sent = Buffer.from(args[0], "base64");
    throw new Error("Lost RPC acknowledgement");
  });
  provider.outcome.mockReset().mockImplementation(async (hash: string) => {
    filled = true;
    const result = nativeOutcomeFixture(prepared);
    return { ...result, transaction: { ...result.transaction, hash } };
  });
});
afterEach(async () => {
  await context.postgres.close();
});
describe("durable native RHEA execution", () => {
  it("does not broadcast when actual native tokens disappeared after confirmation", async () => {
    const preview = await quoteManualTrade(context.db, "owner", {
      requestId: crypto.randomUUID(),
      source: "spot",
      intent: {
        kind: "spot",
        inputAssetId: prepared.quote.input.assetId,
        outputAssetId: prepared.quote.output.assetId,
        amount: "0.0000000000000000000001",
        balance: "native_near",
        slippageBps: 50,
        maximumFeeBps: 0,
      },
    });
    const confirmed = await confirmManualTrade(context.db, "owner", {
      id: preview.id,
      revision: preview.revision,
      bindingHash: preview.bindingHash,
    });
    if (!confirmed.actionId) {
      throw new Error("Missing native action");
    }
    provider.balance.mockResolvedValueOnce({ value: "0" });
    await advanceLedgerAction(context.db, "owner", confirmed.actionId);
    expect(provider.broadcast).not.toHaveBeenCalled();
    expect(await context.db.select().from(nativeSubmissions)).toHaveLength(0);
    expect(
      await context.db.select().from(executionActions).where(eq(executionActions.id, confirmed.actionId)),
    ).toMatchObject([{ status: "cancelled" }]);
  });
  it("finalizes output registration before signing the swap and never repeats either submission", async () => {
    prepared = { ...prepared, registrationDeposit: "1000000000000000000000" };
    prepared = {
      ...prepared,
      payloadHash: executionHash({
        swap: rheaSwapCall(prepared),
        registrationDeposit: prepared.registrationDeposit,
        accountId: prepared.accountId,
      }),
    };
    provider.outcome.mockImplementation(async (hash: string) => {
      const [journal] = await context.db
        .select()
        .from(nativeSubmissions)
        .where(eq(nativeSubmissions.transactionHash, hash));
      if (journal?.role !== "registration") {
        filled = true;
        const result = nativeOutcomeFixture(prepared);
        return { ...result, transaction: { ...result.transaction, hash } };
      }
      return {
        final_execution_status: "FINAL",
        transaction: {
          hash,
          signer_id: prepared.accountId,
          receiver_id: prepared.quote.output.assetId.slice(7),
          actions: [
            {
              FunctionCall: {
                method_name: "storage_deposit",
                args: Buffer.from(
                  JSON.stringify({ account_id: prepared.accountId, registration_only: true }),
                ).toString("base64"),
                gas: "30000000000000",
                deposit: prepared.registrationDeposit,
              },
            },
          ],
        },
        transaction_outcome: {
          id: "registration-tx",
          outcome: {
            executor_id: prepared.accountId,
            receipt_ids: ["registration"],
            logs: [],
            tokens_burnt: "1",
            status: { SuccessReceiptId: "registration" },
          },
        },
        receipts_outcome: [
          {
            id: "registration",
            outcome: {
              executor_id: prepared.quote.output.assetId.slice(7),
              receipt_ids: [],
              logs: [],
              tokens_burnt: "2",
              status: { SuccessValue: "" },
            },
          },
        ],
        status: { SuccessValue: "" },
      };
    });
    const preview = await quoteManualTrade(context.db, "owner", {
      requestId: crypto.randomUUID(),
      source: "spot",
      intent: {
        kind: "spot",
        inputAssetId: prepared.quote.input.assetId,
        outputAssetId: prepared.quote.output.assetId,
        amount: "0.0000000000000000000001",
        balance: "native_near",
        slippageBps: 50,
        maximumFeeBps: 0,
      },
    });
    const confirmed = await confirmManualTrade(context.db, "owner", {
      id: preview.id,
      revision: preview.revision,
      bindingHash: preview.bindingHash,
    });
    if (!confirmed.actionId) {
      throw new Error("Missing native action");
    }
    await advanceLedgerAction(context.db, "owner", confirmed.actionId);
    expect(await context.db.select().from(nativeSubmissions)).toMatchObject([
      { role: "registration", finalizedAt: null },
    ]);
    await advanceLedgerAction(context.db, "owner", confirmed.actionId);
    expect(await context.db.select().from(nativeSubmissions)).toHaveLength(2);
    await advanceLedgerAction(context.db, "owner", confirmed.actionId);
    await advanceLedgerAction(context.db, "owner", confirmed.actionId);
    expect(provider.broadcast).toHaveBeenCalledTimes(2);
    expect(await context.db.select().from(executionFills)).toMatchObject([
      { scope: "native_near", inputUnits: 100n },
    ]);
  });
  it("journals exact signed bytes and an unsafe-in-Number nonce before broadcast, then reconciles without a second send", async () => {
    const preview = await quoteManualTrade(context.db, "owner", {
      requestId: crypto.randomUUID(),
      source: "spot",
      intent: {
        kind: "spot",
        inputAssetId: prepared.quote.input.assetId,
        outputAssetId: prepared.quote.output.assetId,
        amount: "0.0000000000000000000001",
        balance: "native_near",
        slippageBps: 50,
        maximumFeeBps: 0,
      },
    });
    const confirmed = await confirmManualTrade(context.db, "owner", {
      id: preview.id,
      revision: preview.revision,
      bindingHash: preview.bindingHash,
    });
    if (!confirmed.actionId) {
      throw new Error("Missing native action");
    }
    await advanceLedgerAction(context.db, "owner", confirmed.actionId);
    const [journal] = await context.db.select().from(nativeSubmissions);
    expect(journal).toMatchObject({
      actionId: confirmed.actionId,
      nonce: 10000000000000001n,
      finalizedAt: null,
    });
    expect(journal?.sealedTransaction).not.toContain("ed25519:");
    if (!sent) {
      throw new Error("No offline transaction was sent");
    }
    const decoded = decodeSignedTransaction(sent),
      hash = createHash("sha256").update(encodeTransaction(decoded.transaction)).digest();
    expect(decoded.transaction.nonce).toBe(10000000000000001n);
    expect(journal?.transactionHash).toBe(base58.encode(hash));
    const key = (await tradingAccountSigningKeys(context.db, "owner", prepared.rootId)).native;
    const signature = z
      .object({ ed25519Signature: z.object({ data: z.array(z.number().int().min(0).max(255)).length(64) }) })
      .parse(decoded.signature);
    expect(key.verify(hash, Uint8Array.from(signature.ed25519Signature.data))).toBe(true);
    await advanceLedgerAction(context.db, "owner", confirmed.actionId);
    await advanceLedgerAction(context.db, "owner", confirmed.actionId);
    expect(provider.broadcast).toHaveBeenCalledTimes(1);
    expect(
      await context.db.select().from(executionActions).where(eq(executionActions.id, confirmed.actionId)),
    ).toMatchObject([{ status: "settled", origin: "manual", reservationReleasedAt: expect.any(Number) }]);
    expect(await context.db.select().from(executionFills)).toMatchObject([
      { scope: "native_near", inputUnits: 100n, outputUnits: 200n },
    ]);
  });
});
