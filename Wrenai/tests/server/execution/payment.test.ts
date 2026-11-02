import { createSecretKey } from "node:crypto";
import { executionTestContext, fundTestAgent, observeInventory } from "@tests/server/execution/test-context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimes, agents, strategyVersions } from "@/server/db/agent-schema";
import { delegatedKeys } from "@/server/db/schema";
import { generateAgentKey } from "@/server/delegation/agent-key";
import { initialInstructionState } from "@/server/engine/instruction-state";
import { advanceLedgerAction } from "@/server/engine/ledger-action";
import { planPaymentCheck } from "@/server/engine/payment-check";
import { privateTokenId } from "@/server/execution/confidential-intents";
import { preparePaymentExecution } from "@/server/execution/payment-order";
import { synchronizePrivateInventory } from "@/server/execution/private-inventory";
import { executionHash, ownedLedgerAction } from "@/server/execution/records";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { agentInstructionSchema } from "@/shared/agent-instructions";

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)) }),
}));
vi.mock("@/server/intents/verifier", () => ({
  readKeyRegistration: async () => ({ registered: true, blockHeight: 2 }),
}));
vi.mock("@/server/execution/balance-session", () => ({ privateBalanceToken: async () => "offline-session" }));
vi.mock("@/server/execution/private-inventory", () => ({ synchronizePrivateInventory: vi.fn() }));
vi.mock("@defuse-protocol/one-click-sdk-typescript", async (original) => ({
  ...(await original<typeof import("@defuse-protocol/one-click-sdk-typescript")>()),
  verifyQuoteSignature: () => true,
}));
const provider = vi.hoisted(() => ({ request: vi.fn(), status: vi.fn() }));
vi.mock("@/server/execution/oneclick-quote", async (original) => ({
  ...(await original<typeof import("@/server/execution/oneclick-quote")>()),
  oneClickJson: provider.request,
}));
const asset = "nep141:usdc.test-fixture.near",
  deposit = "a".repeat(64);
let context: Awaited<ReturnType<typeof executionTestContext>>;
let rawQuote: unknown;
let remainingBalance: string;
let intentHash: string;
beforeEach(async () => {
  context = await executionTestContext({}, {}, false);
  const instruction = paymentInstruction();
  await context.db.update(agents).set({ pack: "private_payments" }).where(eq(agents.id, context.agentId));
  await context.db
    .update(strategyVersions)
    .set({
      configJson: JSON.stringify(instruction),
      resolvedAssetsJson: JSON.stringify({
        strategyHash: executionHash(instruction),
        assets: [{ symbol: asset, assetId: asset }],
      }),
    })
    .where(eq(strategyVersions.agentId, context.agentId));
  await context.db.update(delegatedKeys).set(generateAgentKey()).where(eq(delegatedKeys.userId, "owner"));
  await observeInventory(context.db, "confidential", "20000000");
  await fundTestAgent(context.db, context.agentId, "20000000", "20000000");
  remainingBalance = "20000000";
  vi.mocked(synchronizePrivateInventory)
    .mockReset()
    .mockImplementation((db) => observeInventory(db, "confidential", remainingBalance));
  await context.db.insert(agentRuntimes).values({
    userId: "owner",
    agentId: context.agentId,
    activationId: crypto.randomUUID(),
    inputHash: "a".repeat(64),
    agentRevision: 1,
    strategyVersion: 1,
    state: "active",
    nextCheckAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    strategyStateJson: JSON.stringify({
      ...initialInstructionState("private_payments"),
      quantityUnits: "1000000",
    }),
  });
  intentHash = "1".repeat(44);
  const deadline = Date.now() + 24 * 3600_000;
  const nonce = Buffer.alloc(32, 0);
  Buffer.from([86, 40, 246, 198, 0, 225, 16, 243, 23]).copy(nonce);
  nonce.writeBigUInt64LE(BigInt(deadline) * 1_000_000n, 9);
  provider.request.mockReset().mockImplementation(async (path: string, body: unknown) => {
    if (path === "/v0/quote") {
      rawQuote = {
        correlationId: "offline",
        timestamp: new Date().toISOString(),
        signature: "offline-provider-signature",
        quoteRequest: body,
        quote: {
          amountIn: "1000000",
          minAmountIn: "1000000",
          amountOut: "1000000",
          minAmountOut: "1000000",
          amountInFormatted: "1",
          amountOutFormatted: "1",
          amountInUsd: "1",
          amountOutUsd: "1",
          timeEstimate: 1,
          depositAddress: deposit,
          deadline: new Date(deadline).toISOString(),
        },
      };
      return rawQuote;
    }
    if (path === "/v0/generate-intent") {
      return {
        correlationId: "offline",
        intent: {
          standard: "nep413",
          payload: {
            recipient: "intents.far",
            nonce: nonce.toString("base64"),
            message: JSON.stringify({
              signer_id: "owner.near",
              deadline: new Date(deadline).toISOString(),
              intents: [
                { intent: "transfer", receiver_id: deposit, tokens: { [privateTokenId(asset)]: "1000000" } },
              ],
            }),
          },
        },
      };
    }
    if (path === "/v0/submit-intent") {
      return { intentHash, correlationId: "offline-submit" };
    }
    throw new Error("Unexpected provider operation");
  });
  provider.status.mockReset().mockImplementation(() => ({
    quoteResponse: rawQuote,
    status: "PROCESSING",
    updatedAt: new Date().toISOString(),
    swapDetails: { intentHashes: [intentHash] },
  }));
  vi.stubEnv("ONECLICK_JWT", "offline-status-credential");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string) => {
      if (!String(url).startsWith("https://1click.chaindefuser.com/v0/status?")) {
        throw new Error("Unexpected network request");
      }
      return Response.json(provider.status());
    }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await context.postgres.close();
});
function paymentInstruction() {
  const parsed = agentInstructionSchema.parse({
    format: 2,
    kind: "private_payments",
    assetId: asset,
    amountUnits: "1000000",
    recipient: "recipient.near",
    destination: "confidential",
    executeAfter: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  if (parsed.kind !== "private_payments") {
    throw new Error("Expected payment fixture");
  }
  return parsed;
}
async function prepare() {
  const [runtime] = await context.db
    .select()
    .from(agentRuntimes)
    .where(eq(agentRuntimes.agentId, context.agentId))
    .limit(1);
  if (!runtime) {
    throw new Error("Missing runtime");
  }
  const planned = await planPaymentCheck(context.db, runtime, paymentInstruction());
  if (!planned.paymentRequestId || !planned.progress) {
    throw new Error("Missing eligible payment");
  }
  await context.db
    .update(agentRuntimes)
    .set({ strategyStateJson: JSON.stringify(planned.progress.strategyState) })
    .where(eq(agentRuntimes.agentId, context.agentId));
  const action = await preparePaymentExecution(
    context.db,
    "owner",
    context.agentId,
    1,
    planned.paymentRequestId,
  );
  await context.db
    .update(agentRuntimes)
    .set({
      strategyStateJson: JSON.stringify({ ...planned.progress.strategyState, pendingActionId: action.id }),
    })
    .where(eq(agentRuntimes.agentId, context.agentId));
  return action;
}
function finalStatus(
  status: "SUCCESS" | "REFUNDED",
  amountIn: string,
  amountOut: string,
  refundedAmount: string,
): void {
  provider.status.mockImplementation(() => ({
    quoteResponse: rawQuote,
    status,
    updatedAt: new Date().toISOString(),
    swapDetails: {
      amountIn,
      amountOut,
      depositedAmount: "1000000",
      refundedAmount,
      amountInUsd: amountIn === "0" ? "0" : "1",
      intentHashes: [intentHash],
    },
  }));
}
describe("exact-amount confidential payments with offline provider assertions", () => {
  it("reconciles the recipient amount without inventing an owned output lot", async () => {
    const action = await prepare();
    expect(await advanceLedgerAction(context.db, "owner", action.id)).toBe(5);
    expect((await ownedLedgerAction(context.db, "owner", action.id)).status).toBe("submitted");
    finalStatus("SUCCESS", "1000000", "1000000", "0");
    remainingBalance = "19000000";
    expect(await advanceLedgerAction(context.db, "owner", action.id)).toBe(60);
    expect(await unreservedOwnedUnits(context.db, "owner", context.agentId, "confidential", asset)).toBe(
      19000000n,
    );
    const [runtime] = await context.db
      .select()
      .from(agentRuntimes)
      .where(eq(agentRuntimes.agentId, context.agentId))
      .limit(1);
    if (!runtime) {
      throw new Error("Missing runtime");
    }
    const planned = await planPaymentCheck(context.db, runtime, paymentInstruction());
    expect(planned.progress?.completed).toBe(true);
    expect(planned.reason).toContain("confirmed");
  });
  it("retains ambiguous submissions and never signs again during recovery", async () => {
    const action = await prepare();
    provider.request.mockImplementationOnce(async () => {
      throw new Error("Acknowledgement lost");
    });
    await advanceLedgerAction(context.db, "owner", action.id);
    expect((await ownedLedgerAction(context.db, "owner", action.id)).status).toBe("unknown");
    const submits = provider.request.mock.calls.filter((call) => call[0] === "/v0/submit-intent").length;
    await advanceLedgerAction(context.db, "owner", action.id, "reconcile_only");
    expect(provider.request.mock.calls.filter((call) => call[0] === "/v0/submit-intent")).toHaveLength(
      submits,
    );
    expect((await ownedLedgerAction(context.db, "owner", action.id)).reservationReleasedAt).toBeNull();
  });
  it("returns a proven full refund to availability without fabricating a spending receipt", async () => {
    const action = await prepare();
    await advanceLedgerAction(context.db, "owner", action.id);
    finalStatus("REFUNDED", "0", "0", "1000000");
    await advanceLedgerAction(context.db, "owner", action.id);
    expect(await unreservedOwnedUnits(context.db, "owner", context.agentId, "confidential", asset)).toBe(
      20000000n,
    );
    expect((await ownedLedgerAction(context.db, "owner", action.id)).reservationReleasedAt).not.toBeNull();
  });
  it("rejects incomplete terminal accounting and preserves the reservation", async () => {
    const action = await prepare();
    await advanceLedgerAction(context.db, "owner", action.id);
    finalStatus("SUCCESS", "1000000", "999999", "0");
    await expect(advanceLedgerAction(context.db, "owner", action.id)).rejects.toMatchObject({
      code: "not_ready",
    });
    expect((await ownedLedgerAction(context.db, "owner", action.id)).reservationReleasedAt).toBeNull();
  });
});
