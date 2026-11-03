import { createSecretKey } from "node:crypto";
import { perpsTestContext } from "@tests/server/execution/hyperliquid/db-context";
import { OfflineReturnVenue, returnToken } from "@tests/server/execution/hyperliquid/return-fixture";
import { observeInventory } from "@tests/server/execution/test-context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentEvents, agents } from "@/server/db/agent-schema";
import { executionReceipts } from "@/server/db/defi-schema";
import { delegatedKeys } from "@/server/db/schema";
import { advanceLedgerAction } from "@/server/engine/ledger-action";
import { defiPlanSchema } from "@/server/execution/defi-contracts";
import { synchronizePerpsInventory } from "@/server/execution/hyperliquid/account-state";
import { perpsCashAssetId } from "@/server/execution/hyperliquid/contracts";
import { preparePerpsReturn } from "@/server/execution/hyperliquid/return-prepare";
import { createPerpsReturnPreview } from "@/server/execution/hyperliquid/return-preview";
import {
  readReturnRecord,
  validateReturnPlan,
  verifiedReturnQuote,
} from "@/server/execution/hyperliquid/return-record";
import { verifiedReturnFunding } from "@/server/execution/hyperliquid/return-source";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { ownedLedgerAction } from "@/server/execution/records";
import { readSpendingUsage } from "@/server/execution/usage";
import { assignInventory } from "@/server/positions/attribution";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { revokeTradingAccounts } from "@/server/trading-accounts/vault";
import type { HlUsdSend } from "@/shared/perps-return";

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)) }),
}));
vi.mock("@/server/intents/verifier", () => ({
  readKeyRegistration: async () => ({ registered: true, blockHeight: 2 }),
}));
vi.mock("@/server/execution/balance-session", () => ({ privateBalanceToken: async () => "offline-session" }));
vi.mock("@/server/research/intents", () => ({ intentTokens: vi.fn() }));
vi.mock("@/server/execution/private-inventory", () => ({ synchronizePrivateInventory: vi.fn() }));
vi.mock("@defuse-protocol/one-click-sdk-typescript", async (original) => ({
  ...(await original<typeof import("@defuse-protocol/one-click-sdk-typescript")>()),
  verifyQuoteSignature: () => true,
}));
const provider = vi.hoisted(() => ({ quote: vi.fn(), info: vi.fn(), transfer: vi.fn() }));
vi.mock("@/server/execution/oneclick-quote", async (original) => ({
  ...(await original<typeof import("@/server/execution/oneclick-quote")>()),
  oneClickJson: provider.quote,
}));
vi.mock("@/server/execution/hyperliquid/transport", () => ({
  hlInfo: provider.info,
  hlTransfer: provider.transfer,
}));

import { intentTokens } from "@/server/research/intents";

const user = { id: "owner", accountId: "owner.near" };
let context: Awaited<ReturnType<typeof perpsTestContext>>;
let venue: OfflineReturnVenue;
beforeEach(async () => {
  context = await perpsTestContext();
  venue = new OfflineReturnVenue();
  provider.info
    .mockReset()
    .mockImplementation(async (body: Readonly<Record<string, unknown>>) => venue.info(body));
  provider.transfer.mockReset().mockImplementation(async (action: HlUsdSend) => venue.transfer(action));
  provider.quote.mockReset().mockImplementation(async (path: string, body: unknown) => {
    if (path !== "/v0/quote") {
      throw new Error("Unexpected return API");
    }
    return venue.makeQuote(body);
  });
  vi.mocked(intentTokens).mockResolvedValue({
    tokens: [returnToken],
    source: { id: "offline", label: "Offline registry", url: "https://example.test", observedAt: Date.now() },
  });
  vi.mocked(synchronizePrivateInventory)
    .mockReset()
    .mockImplementation((db) => observeInventory(db, "confidential", venue.privateUnits));
  await context.db.update(agents).set({ status: "paused" }).where(eq(agents.id, context.agentId));
  await synchronizePerpsInventory(context.db, user.id, context.agentId);
  await assignInventory(context.db, user.id, {
    requestId: crypto.randomUUID(),
    agentId: context.agentId,
    scope: "hyperliquid",
    assetId: perpsCashAssetId(context.account.perpAddress),
    quantityUnits: "10000000",
    capitalMicroUsd: "10000000",
    costBasisMicroUsd: "10000000",
    sourceReference: "offline-owned-venue-cash",
    evidenceHash: "f".repeat(64),
  });
  vi.stubEnv("ONECLICK_JWT", "offline-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      if (!String(url).startsWith("https://1click.chaindefuser.com/v0/status?")) {
        throw new Error("Unexpected network request");
      }
      return Response.json(venue.status());
    }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await context.postgres.close();
});
async function preview(): Promise<Awaited<ReturnType<typeof createPerpsReturnPreview>>> {
  return createPerpsReturnPreview(context.db, user, {
    agentId: context.agentId,
    expectedRevision: 1,
    requestId: crypto.randomUUID(),
  });
}
async function prepare(): Promise<Awaited<ReturnType<typeof preparePerpsReturn>>> {
  const result = await preview();
  return preparePerpsReturn(context.db, user, { previewId: result.id, evidenceHash: result.evidenceHash });
}
describe("owner-confirmed Perps return with shared-ledger recovery", () => {
  it("rejects expired previews and changed return amounts before signing", async () => {
    const action = await prepare(),
      plan = defiPlanSchema.parse(JSON.parse(action.planJson)),
      saved = await readReturnRecord(context.db, action);
    expect(() => verifiedReturnQuote(saved, saved.expiresAt)).toThrow("expired");
    expect(() => verifiedReturnQuote({ ...saved, debitUnits: "11000000" }, saved.quotedAt)).toThrow();
    expect(() =>
      validateReturnPlan({ ...plan, recipient: "stranger.near" }, saved, saved.quotedAt),
    ).toThrow();
    expect(venue.transferCalls).toBe(0);
  });
  it("previews all owned cash, includes the separate USDC fee, and does not sign", async () => {
    const value = await preview();
    expect(value).toMatchObject({
      debitUnits: "10000000",
      networkFeeUnits: "1000000",
      receiveUnits: "8756000",
      quotedReceiveUnits: "8800000",
      destinationAccount: user.accountId,
    });
    expect(provider.transfer).not.toHaveBeenCalled();
  });
  it("returns once, reconciles both balances, preserves principal and excludes internal transfers from new-risk usage", async () => {
    const saved = await preview(),
      confirmation = { previewId: saved.id, evidenceHash: saved.evidenceHash };
    const action = await preparePerpsReturn(context.db, user, confirmation);
    expect((await preparePerpsReturn(context.db, user, confirmation)).id).toBe(action.id);
    await advanceLedgerAction(context.db, user.id, action.id);
    expect(venue.request).toMatchObject({ type: "usdSend", amount: "10", hyperliquidChain: "Mainnet" });
    expect((await ownedLedgerAction(context.db, user.id, action.id)).reservationReleasedAt).toBeNull();
    venue.complete();
    await advanceLedgerAction(context.db, user.id, action.id, "reconcile_only");
    await advanceLedgerAction(context.db, user.id, action.id, "reconcile_only");
    expect((await ownedLedgerAction(context.db, user.id, action.id)).reservationReleasedAt).not.toBeNull();
    expect(venue.transferCalls).toBe(1);
    expect(await context.db.select().from(executionReceipts)).toHaveLength(1);
    expect(
      await unreservedOwnedUnits(context.db, user.id, context.agentId, "confidential", returnToken.assetId),
    ).toBe(28_800_000n);
    expect(
      await unreservedOwnedUnits(
        context.db,
        user.id,
        context.agentId,
        "hyperliquid",
        perpsCashAssetId(context.account.perpAddress),
      ),
    ).toBe(0n);
    expect(
      (await readSpendingUsage(context.db, user.id, context.agentId, Date.now())).agentSpent24hMicroUsd,
    ).toBe(0n);
  });
  it("settles after lost acknowledgement and revocation without producing a second signature", async () => {
    const action = await prepare();
    venue.lostAck = true;
    await advanceLedgerAction(context.db, user.id, action.id);
    expect((await ownedLedgerAction(context.db, user.id, action.id)).status).toBe("unknown");
    await revokeTradingAccounts(context.db, user.id);
    await context.db.delete(delegatedKeys).where(eq(delegatedKeys.userId, user.id));
    venue.complete();
    await advanceLedgerAction(context.db, user.id, action.id, "reconcile_only");
    expect(venue.transferCalls).toBe(1);
    expect((await ownedLedgerAction(context.db, user.id, action.id)).status).toBe("settled");
  });
  it.each([
    { refund: 900_000_000n, output: 0n },
    { refund: 450_000_000n, output: 4_400_000n },
    { refund: 450_000_001n, output: 4_399_999n },
  ])(
    "accounts for a refund of $refund bridge units without refunding the non-refundable transfer fee",
    async ({ refund, output }) => {
      const action = await prepare();
      await advanceLedgerAction(context.db, user.id, action.id);
      venue.complete(refund, output);
      await advanceLedgerAction(context.db, user.id, action.id, "reconcile_only");
      expect((await ownedLedgerAction(context.db, user.id, action.id)).reservationReleasedAt).not.toBeNull();
      expect(
        await unreservedOwnedUnits(
          context.db,
          user.id,
          context.agentId,
          "hyperliquid",
          perpsCashAssetId(context.account.perpAddress),
        ),
      ).toBe(refund / 100n);
      expect(venue.transferCalls).toBe(1);
    },
  );
  it("does not sign a reserved return during read-only recovery", async () => {
    const action = await prepare();
    await advanceLedgerAction(context.db, user.id, action.id, "reconcile_only");
    expect(venue.transferCalls).toBe(0);
  });
  it.each(["position", "orders", "running"])("blocks returns with %s still active", async (kind) => {
    venue.positionOpen = kind === "position";
    venue.orderOpen = kind === "orders";
    if (kind === "running") {
      await context.db.update(agents).set({ status: "running" }).where(eq(agents.id, context.agentId));
    }
    await expect(preview()).rejects.toThrow();
    expect(provider.quote).not.toHaveBeenCalled();
  });
  it("rejects another owner, changed evidence and arbitrary recipient fields", async () => {
    const saved = await preview();
    await expect(
      preparePerpsReturn(
        context.db,
        { id: "stranger", accountId: "stranger.near" },
        { previewId: saved.id, evidenceHash: saved.evidenceHash },
      ),
    ).rejects.toThrow("not found");
    await expect(
      preparePerpsReturn(context.db, user, { previewId: saved.id, evidenceHash: "f".repeat(64) }),
    ).rejects.toThrow();
    await expect(
      preparePerpsReturn(context.db, user, {
        previewId: saved.id,
        evidenceHash: saved.evidenceHash,
        destination: "stranger.near",
      }),
    ).rejects.toThrow();
    expect(venue.transferCalls).toBe(0);
  });
  it.each(["hash", "money"])(
    "retains holds when the source %s does not match terminal provider assertions",
    async (kind) => {
      const action = await prepare();
      await advanceLedgerAction(context.db, user.id, action.id);
      venue.complete();
      venue.badHash = kind === "hash";
      venue.wrongMoney = kind === "money";
      await expect(advanceLedgerAction(context.db, user.id, action.id, "reconcile_only")).rejects.toThrow();
      expect((await ownedLedgerAction(context.db, user.id, action.id)).reservationReleasedAt).toBeNull();
      expect(await context.db.select().from(executionReceipts)).toHaveLength(0);
    },
  );
  it("does not allow a funding flag without the exact owner-confirmation audit proof", async () => {
    const action = await prepare(),
      plan = defiPlanSchema.parse(JSON.parse(action.planJson));
    const saved = await readReturnRecord(context.db, action);
    expect(saved.debitUnits).toBe("10000000");
    await context.db.delete(agentEvents).where(eq(agentEvents.kind, "perps_return_confirmed"));
    await expect(verifiedReturnFunding(context.db, user.id, plan, user, action.id)).rejects.toThrow(
      "Confirm this exact",
    );
    expect(venue.transferCalls).toBe(0);
  });
});
