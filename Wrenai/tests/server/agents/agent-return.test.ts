import { createSecretKey } from "node:crypto";
import { fundingAsset, fundingTestContext } from "@tests/server/funding/context";
import { OfflineFundingProvider } from "@tests/server/funding/provider";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { advanceAgentReturn, deleteIfNothingHeld } from "@/server/agents/agent-return";
import { commandAgent } from "@/server/agents/mutations";
import { agents } from "@/server/db/agent-schema";
import { executionActions } from "@/server/db/execution-schema";
import { walletFundings } from "@/server/db/funding-schema";
import { advanceLedgerAction } from "@/server/engine/ledger-action";
import { beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { prepareWalletReturn } from "@/server/execution/wallet-return";
import { releaseWalletAttempt } from "@/server/funding/cancel";
import { prepareWalletConversion } from "@/server/funding/conversion";
import { confirmWalletDeposit, markWalletFundingAttempt } from "@/server/funding/deposit";
import { prepareWalletFunding } from "@/server/funding/prepare";
import { advanceFundingRecord } from "@/server/funding/progress";
import { callViewFunction, readFinalTransaction } from "@/server/near/rpc";
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

async function review() {
  const funding = await prepareWalletFunding(context.db, user, {
    requestId: crypto.randomUUID(),
    agentId: context.agentId,
    expectedRevision: 1,
  });
  provider.snapshot = funding.snapshot;
  return funding;
}
/** Deposit and convert, so the agent holds 4.99 USDC in the private balance. */
async function fundPrivately(): Promise<void> {
  const funding = await review();
  await markWalletFundingAttempt(context.db, user, { fundingId: funding.id });
  await confirmWalletDeposit(context.db, user, { fundingId: funding.id, transactionHash: provider.hash });
  const action = await prepareWalletConversion(context.db, user, funding.id);
  provider.terminal = true;
  await advanceLedgerAction(context.db, user.id, action.id);
  provider.privateUnits = "4990000";
  await advanceFundingRecord(context.db, user.id, funding.id);
}
async function agentCommand(command: "delete" | "claim"): Promise<void> {
  const [agent] = await context.db.select().from(agents).where(eq(agents.id, context.agentId));
  await commandAgent(context.db, user.id, {
    requestId: crypto.randomUUID(),
    agentId: context.agentId,
    expectedRevision: agent?.revision ?? 0,
    command,
  });
}
async function deleteAgent(): Promise<void> {
  await agentCommand("delete");
}

describe("a delete leaves funds in Claims; only a claim sends them to the wallet", () => {
  it("deletes without sending anything while the agent still holds funds", async () => {
    await fundPrivately();
    await deleteAgent();
    expect(await deleteIfNothingHeld(context.db, user, context.agentId)).toBe(false);
    expect(await advanceAgentReturn(context.db, user.id, context.agentId)).toEqual({ kind: "done" });
    const [agent] = await context.db.select().from(agents).where(eq(agents.id, context.agentId));
    expect(agent).toMatchObject({ status: "stopped", deletedAt: null, claimRequestedAt: null });
    expect(agent?.deleteRequestedAt).not.toBeNull();
    expect(
      await unreservedOwnedUnits(context.db, user.id, context.agentId, "confidential", fundingAsset),
    ).toBe(4990000n);
    // Only the funding conversion was signed.
    expect(provider.submissions).toBe(1);
  });

  it("sends a deleted agent's claimed token to the owner's NEAR wallet, settles it, then deletes the agent", async () => {
    await fundPrivately();
    expect(
      await unreservedOwnedUnits(context.db, user.id, context.agentId, "confidential", fundingAsset),
    ).toBe(4990000n);
    await deleteAgent();
    await agentCommand("claim");
    for (let step = 0; step < 6; step += 1) {
      if ((await advanceAgentReturn(context.db, user.id, context.agentId)).kind === "done") {
        break;
      }
    }
    const quote = z
      .object({
        quoteRequest: z.object({
          swapType: z.string(),
          originAsset: z.string(),
          destinationAsset: z.string(),
          amount: z.string(),
          recipient: z.string(),
          recipientType: z.string(),
          depositType: z.string(),
        }),
      })
      .parse(provider.rawQuote).quoteRequest;
    expect(quote).toEqual({
      swapType: "EXACT_INPUT",
      originAsset: fundingAsset,
      destinationAsset: fundingAsset,
      amount: "4990000",
      recipient: "owner.near",
      recipientType: "DESTINATION_CHAIN",
      depositType: "CONFIDENTIAL_INTENTS",
    });
    const [agent] = await context.db.select().from(agents).where(eq(agents.id, context.agentId));
    expect(agent?.deletedAt).not.toBeNull();
    expect(
      await unreservedOwnedUnits(context.db, user.id, context.agentId, "confidential", fundingAsset),
    ).toBe(0n);
    expect(await committedCapital(context.db, user.id, context.agentId)).toBe(0n);
    const actions = await context.db.select().from(executionActions);
    expect(actions.filter((action) => action.status === "settled")).toHaveLength(2);
    expect(actions.every((action) => action.reservationReleasedAt !== null)).toBe(true);
    // The conversion and the return were each signed once.
    expect(provider.submissions).toBe(2);
  });

  it("keeps funds reserved while the provider has not confirmed wallet delivery", async () => {
    await fundPrivately();
    await agentCommand("claim");
    provider.terminal = false;
    for (let step = 0; step < 3; step += 1) {
      await advanceAgentReturn(context.db, user.id, context.agentId);
    }
    const [agent] = await context.db.select().from(agents).where(eq(agents.id, context.agentId));
    expect(agent).toMatchObject({ status: "stopped", deletedAt: null });
    const pending = (await context.db.select().from(executionActions)).filter(
      (action) => action.reservationReleasedAt === null,
    );
    expect(pending).toHaveLength(1);
    expect(provider.submissions).toBe(2);
  });

  it("refuses a wallet return for an agent whose funds the owner has not claimed", async () => {
    await fundPrivately();
    await expect(
      prepareWalletReturn(
        context.db,
        user.id,
        context.agentId,
        "confidential",
        fundingAsset,
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "not_ready" });
    expect(provider.submissions).toBe(1);
  });

  it("closes a declined wallet deposit so a fresh one can be reviewed, and deletes an unfunded agent", async () => {
    const declined = await review();
    await markWalletFundingAttempt(context.db, user, { fundingId: declined.id });
    await releaseWalletAttempt(context.db, user.id, { fundingId: declined.id });
    const fresh = await review();
    expect(fresh.id).not.toBe(declined.id);
    await markWalletFundingAttempt(context.db, user, { fundingId: fresh.id });
    await deleteAgent();
    expect(await deleteIfNothingHeld(context.db, user, context.agentId)).toBe(true);
    const rows = await context.db.select().from(walletFundings);
    expect(rows.map((row) => row.state).toSorted()).toEqual(["abandoned", "abandoned"]);
    expect(rows.every((row) => row.walletAttemptAt !== null)).toBe(true);
    await expect(
      confirmWalletDeposit(context.db, user, { fundingId: declined.id, transactionHash: provider.hash }),
    ).rejects.toMatchObject({ code: "not_ready" });
  });
});
