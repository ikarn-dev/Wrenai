import { createSecretKey } from "node:crypto";
import { fundingAsset, fundingTestContext } from "@tests/server/funding/context";
import { OfflineFundingProvider } from "@tests/server/funding/provider";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executionActions } from "@/server/db/execution-schema";
import { walletFundings } from "@/server/db/funding-schema";
import { positionLots } from "@/server/db/position-schema";
import { advanceLedgerAction } from "@/server/engine/ledger-action";
import { settleDefiExecution } from "@/server/execution/defi-accounting";
import { beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import { beginSubmission, claimExecution } from "@/server/execution/ownership";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { ownedLedgerAction } from "@/server/execution/records";
import { prepareWalletConversion } from "@/server/funding/conversion";
import { confirmWalletDeposit, markWalletFundingAttempt } from "@/server/funding/deposit";
import { prepareWalletFunding } from "@/server/funding/prepare";
import { advanceFundingRecord, discardFundingReview, keepFundingPublic } from "@/server/funding/progress";
import { synchronizePublicToken } from "@/server/funding/public-inventory";
import { linkedAgentBudget } from "@/server/funding/records";
import { callViewFunction, readFinalTransaction } from "@/server/near/rpc";
import { readPortfolioPerformance } from "@/server/portfolio/performance";
import { committedCapital } from "@/server/positions/capital-records";
import { unreservedOwnedUnits } from "@/server/positions/lots";

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)) }),
}));
vi.mock("@/server/intents/verifier", () => ({
  readKeyRegistration: async () => ({ registered: true, blockHeight: 2 }),
}));
vi.mock("@/server/execution/balance-session", () => ({ privateBalanceToken: async () => "offline-session" }));
vi.mock("@/server/db/client", async (original) => ({
  ...(await original<typeof import("@/server/db/client")>()),
  database: () => context.db,
}));
vi.mock("@/server/near/rpc", async (original) => ({
  ...(await original<typeof import("@/server/near/rpc")>()),
  callViewFunction: vi.fn(),
  readFinalTransaction: vi.fn(),
}));
vi.mock("@/server/portfolio/wallet-tokens", () => ({
  walletTokenHolding: async () => ({
    assetId: fundingAsset,
    symbol: "USDC",
    decimals: 6,
    balanceUnits: "10000000",
    spendableUnits: "10000000",
    blockHeight: 1,
    observedAt: Date.now(),
  }),
}));
vi.mock("@/server/research/intents", () => ({
  intentTokens: async () => ({
    tokens: [{ assetId: fundingAsset, symbol: "USDC", decimals: 6, blockchain: "near" }],
  }),
}));
vi.mock("@/server/execution/private-inventory", () => ({ synchronizePrivateInventory: vi.fn() }));
vi.mock("@defuse-protocol/one-click-sdk-typescript", async (original) => ({
  ...(await original<typeof import("@defuse-protocol/one-click-sdk-typescript")>()),
  verifyQuoteSignature: () => true,
}));
const calls = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/server/execution/oneclick-quote", async (original) => ({
  ...(await original<typeof import("@/server/execution/oneclick-quote")>()),
  oneClickJson: calls.request,
}));
let context: Awaited<ReturnType<typeof fundingTestContext>>, provider: OfflineFundingProvider;
const user = { id: "owner", accountId: "owner.near" };
beforeEach(async () => {
  context = await fundingTestContext();
  provider = new OfflineFundingProvider();
  calls.request.mockReset().mockImplementation((path: string, body: unknown) => provider.request(path, body));
  vi.mocked(callViewFunction)
    .mockReset()
    .mockImplementation(async (_contract, method, args) => {
      if (method !== "mt_batch_balance_of") {
        throw new Error("Unexpected contract view");
      }
      return {
        value: z
          .array(z.string())
          .parse(args["token_ids"])
          .map(() => provider.publicUnits),
        blockHeight: 3,
      };
    });
  vi.mocked(readFinalTransaction)
    .mockReset()
    .mockImplementation(async () => provider.transaction());
  vi.mocked(synchronizePrivateInventory)
    .mockReset()
    .mockImplementation(async (db) => {
      const token = await beginInventorySync(db, user.id, "confidential");
      await finishInventorySync(db, user.id, {
        scope: "confidential",
        syncToken: token,
        balances: [{ assetId: fundingAsset, amountUnits: provider.privateUnits }],
      });
    });
  vi.stubEnv("ONECLICK_JWT", "offline-provider");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => provider.status(url)),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await context.postgres.close();
});
async function deposit() {
  const review = await prepareWalletFunding(context.db, user, {
    requestId: crypto.randomUUID(),
    agentId: context.agentId,
    expectedRevision: 1,
  });
  provider.snapshot = review.snapshot;
  await markWalletFundingAttempt(context.db, user, { fundingId: review.id });
  return confirmWalletDeposit(context.db, user, { fundingId: review.id, transactionHash: provider.hash });
}
describe("offline wallet-to-private agent funding", () => {
  it("attributes the finalized wallet deposit once and hands off the wallet earmark atomically", async () => {
    const funding = await deposit();
    await confirmWalletDeposit(context.db, user, { fundingId: funding.id, transactionHash: provider.hash });
    expect(readFinalTransaction).toHaveBeenCalledTimes(1);
    expect(await unreservedOwnedUnits(context.db, user.id, context.agentId, "intents", fundingAsset)).toBe(
      5000000n,
    );
    expect((await linkedAgentBudget(context.db, user.id, context.agentId)).budget?.walletReservedUnits).toBe(
      "0",
    );
    expect(await context.db.select().from(executionActions)).toHaveLength(0);
    await expect(markWalletFundingAttempt(context.db, user, { fundingId: funding.id })).rejects.toMatchObject(
      { code: "conflict" },
    );
    await expect(
      confirmWalletDeposit(
        context.db,
        { id: "stranger", accountId: "stranger.near" },
        { fundingId: funding.id, transactionHash: provider.hash },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it("keeps ambiguous submission single-use and waits for a real destination balance before releasing funds", async () => {
    const funding = await deposit(),
      action = await prepareWalletConversion(context.db, user, funding.id);
    expect((await prepareWalletConversion(context.db, user, funding.id)).id).toBe(action.id);
    provider.loseAcknowledgement = true;
    await advanceLedgerAction(context.db, user.id, action.id);
    expect((await ownedLedgerAction(context.db, user.id, action.id)).status).toBe("unknown");
    expect(provider.submissions).toBe(1);
    await advanceFundingRecord(context.db, user.id, funding.id);
    expect(provider.submissions).toBe(1);
    provider.terminal = true;
    expect(await advanceFundingRecord(context.db, user.id, funding.id)).toBe(true);
    expect((await ownedLedgerAction(context.db, user.id, action.id)).reservationReleasedAt).toBeNull();
    provider.privateUnits = "4990000";
    expect(await advanceFundingRecord(context.db, user.id, funding.id)).toBe(false);
    expect((await context.db.select().from(walletFundings))[0]?.state).toBe("complete");
    expect(
      await unreservedOwnedUnits(context.db, user.id, context.agentId, "confidential", fundingAsset),
    ).toBe(4990000n);
    expect(await committedCapital(context.db, user.id, context.agentId)).toBe(4990000n);
    expect((await readPortfolioPerformance(context.db, user.id)).count).toBe(0);
    expect(provider.submissions).toBe(1);
  });
  it("rejects ambiguous same-token receipt scopes without consuming owned principal", async () => {
    const funding = await deposit(),
      action = await prepareWalletConversion(context.db, user, funding.id),
      worker = await claimExecution(context.db, user.id, action.id);
    await synchronizePublicToken(context.db, user.id, user.accountId, fundingAsset);
    await synchronizePrivateInventory(context.db, user.id);
    await beginSubmission(context.db, user.id, action.id, worker.token, {
      payloadHash:
        action.payloadHash ??
        z.object({ payloadHash: z.string() }).parse(JSON.parse(action.planJson)).payloadHash,
      providerRequestId: crypto.randomUUID(),
    });
    await expect(
      settleDefiExecution(context.db, user.id, action.id, worker.token, {
        providerEventId: "offline-ambiguous",
        riskDebitMicroUsd: "5000000",
        feeMicroUsd: null,
        cash: [
          {
            assetId: fundingAsset,
            debitUnits: "5000000",
            creditUnits: "0",
            creditValueMicroUsd: null,
            creditPrincipalMicroUsd: "0",
          },
          {
            assetId: fundingAsset,
            debitUnits: "0",
            creditUnits: "4990000",
            creditValueMicroUsd: null,
            creditPrincipalMicroUsd: "4990000",
          },
        ],
        positions: [],
        retiredPrincipalMicroUsd: "10000",
        borrowedCapitalMicroUsd: "0",
        occurredAt: Date.now(),
      }),
    ).rejects.toMatchObject({ code: "limit" });
    expect(await committedCapital(context.db, user.id, context.agentId)).toBe(5000000n);
    expect(
      (
        await context.db
          .select()
          .from(positionLots)
          .where(and(eq(positionLots.agentId, context.agentId), eq(positionLots.scope, "intents")))
      )[0]?.remainingUnits,
    ).toBe(5000000n);
  });
  it("rejects a generated intent for another owner before reserving or signing", async () => {
    const funding = await deposit();
    provider.wrongGeneratedOwner = true;
    await expect(prepareWalletConversion(context.db, user, funding.id)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await context.db.select().from(executionActions)).toHaveLength(0);
    expect(provider.submissions).toBe(0);
  });
  it("protects attempted funding history and allows cancelling only an unattempted review", async () => {
    const review = await prepareWalletFunding(context.db, user, {
      requestId: crypto.randomUUID(),
      agentId: context.agentId,
      expectedRevision: 1,
    });
    await discardFundingReview(context.db, user.id, review.id);
    expect(await context.db.select().from(walletFundings)).toHaveLength(0);
    const funding = await deposit();
    await expect(discardFundingReview(context.db, user.id, funding.id)).rejects.toMatchObject({
      code: "not_ready",
    });
    await expect(
      context.db.update(walletFundings).set({ snapshotJson: "{}" }).where(eq(walletFundings.id, funding.id)),
    ).rejects.toThrow();
    await expect(
      context.db.delete(walletFundings).where(eq(walletFundings.id, funding.id)),
    ).rejects.toThrow();
  });
  it("can keep a confirmed unsent deposit public without losing the deposit proof or ownership", async () => {
    const funding = await deposit();
    await keepFundingPublic(context.db, user.id, funding.id);
    expect((await context.db.select().from(walletFundings))[0]?.state).toBe("complete");
    expect(await unreservedOwnedUnits(context.db, user.id, context.agentId, "intents", fundingAsset)).toBe(
      5000000n,
    );
    await expect(prepareWalletConversion(context.db, user, funding.id)).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(provider.submissions).toBe(0);
  });
  it("blocks closing a funding request while its conversion is unresolved", async () => {
    const funding = await deposit();
    await prepareWalletConversion(context.db, user, funding.id);
    await expect(keepFundingPublic(context.db, user.id, funding.id)).rejects.toMatchObject({
      code: "not_ready",
    });
    expect((await context.db.select().from(walletFundings))[0]?.state).toBe("converting");
    expect(provider.submissions).toBe(0);
  });
});
