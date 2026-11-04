import { createSecretKey } from "node:crypto";
import { perpsTestContext } from "@tests/server/execution/hyperliquid/db-context";
import { OfflinePerpsVenue } from "@tests/server/execution/hyperliquid/provider-fixture";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents } from "@/server/db/agent-schema";
import { defiPositions } from "@/server/db/defi-schema";
import { executionActions } from "@/server/db/execution-schema";
import { advanceLedgerAction } from "@/server/engine/ledger-action";
import type { HlAction } from "@/server/execution/hyperliquid/contracts";
import { watchPerpsPosition } from "@/server/execution/hyperliquid/position-watch";
import { advanceManualTrade } from "@/server/manual-trading/advance";
import { confirmManualTrade, quoteManualTrade } from "@/server/manual-trading/service";
import { manualSubject } from "@/server/manual-trading/subject";
import { readAgentTradingAccount } from "@/server/trading-accounts/agent-account";

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({
  serverEnv: () => ({ keyEncryptionKey: createSecretKey(Buffer.alloc(32, 7)) }),
}));
vi.mock("@/server/intents/verifier", () => ({
  readKeyRegistration: async () => ({ registered: true, blockHeight: 2 }),
}));
vi.mock("@/server/research/intents", () => ({
  intentTokens: async () => ({
    tokens: [{ symbol: "USDC", assetId: "nep141:usdc.test-fixture.near", blockchain: "near", decimals: 6 }],
  }),
}));
const provider = vi.hoisted(() => ({ info: vi.fn(), exchange: vi.fn() }));
vi.mock("@/server/execution/hyperliquid/transport", () => ({
  hlInfo: provider.info,
  hlExchange: provider.exchange,
}));
let context: Awaited<ReturnType<typeof perpsTestContext>>, venue: OfflinePerpsVenue;
beforeEach(async () => {
  context = await perpsTestContext();
  venue = new OfflinePerpsVenue();
  venue.cash = 20000000n;
  provider.info
    .mockReset()
    .mockImplementation(async (body: Readonly<Record<string, unknown>>) => venue.info(body));
  provider.exchange.mockReset().mockImplementation(async (action: HlAction) => venue.exchange(action));
});
afterEach(async () => {
  await context.postgres.close();
});
const intent = {
  kind: "perps",
  market: "NEAR",
  action: "open",
  side: "long",
  quantity: "2",
  leverage: 4,
  maximumMarginUsd: "10",
  stopLossPrice: "4",
  takeProfitPrice: "6",
  trailingStopBps: null,
  slippageBps: 50,
  maximumFeeBps: 10,
} as const;
async function confirmedOrder() {
  const preview = await quoteManualTrade(context.db, "owner", {
    requestId: crypto.randomUUID(),
    source: "perps",
    intent,
  });
  return confirmManualTrade(context.db, "owner", {
    id: preview.id,
    revision: preview.revision,
    bindingHash: preview.bindingHash,
  });
}
describe("manual Perps execution", () => {
  it("cleans a retained sibling order before ending the position workflow and permitting return funds", async () => {
    const preview = await confirmedOrder();
    if (!preview.actionId) {
      throw new Error("Missing manual action");
    }
    await advanceLedgerAction(context.db, "owner", preview.actionId);
    await advanceLedgerAction(context.db, "owner", preview.actionId);
    const sibling = [...venue.orders.values()].find(
      (o) => o.status === "open" && "trigger" in o.wire.t && o.wire.t.trigger.tpsl === "tp",
    );
    if (!sibling) {
      throw new Error("The filled entry needs a real protective sibling for this recovery case");
    }
    venue.closeWithNativeStop();
    sibling.status = "open";
    expect(await advanceManualTrade(context.db, "owner", preview.id)).toBe(true);
    expect(sibling.status).toBe("canceled");
    expect(await advanceManualTrade(context.db, "owner", preview.id)).toBe(false);
    expect(venue.entryCalls).toBe(1);
  });
  it("uses a separate derived address and no hidden agent; repairs protection on an actual partial IOC", async () => {
    const preview = await confirmedOrder();
    if (!preview.actionId) {
      throw new Error("Missing manual action");
    }
    const subject = await manualSubject(context.db, "owner"),
      account = await readAgentTradingAccount(context.db, "owner", subject);
    expect(account?.perpAddress).not.toBe(context.account.perpAddress);
    expect(await context.db.select().from(agents)).toHaveLength(1);
    await advanceLedgerAction(context.db, "owner", preview.actionId);
    await advanceLedgerAction(context.db, "owner", preview.actionId);
    expect(venue.entryCalls).toBe(1);
    expect(venue.protectionCalls).toBeGreaterThan(0);
    const [action] = await context.db
      .select()
      .from(executionActions)
      .where(eq(executionActions.id, preview.actionId));
    expect(action).toMatchObject({ origin: "manual", status: "settled", agentId: subject });
    expect(
      await context.db
        .select()
        .from(defiPositions)
        .where(and(eq(defiPositions.agentId, subject), eq(defiPositions.kind, "perp_long"))),
    ).toMatchObject([{ quantityUnits: 200n }]);
    venue.closeWithNativeStop();
    await watchPerpsPosition(context.db, "owner", subject, false);
    expect(
      await context.db
        .select()
        .from(defiPositions)
        .where(and(eq(defiPositions.agentId, subject), eq(defiPositions.kind, "perp_long"))),
    ).toMatchObject([{ quantityUnits: 0n }]);
  });
  it("reconciles a lost entry acknowledgement without placing another entry", async () => {
    venue.loseEntryAck = true;
    const preview = await confirmedOrder();
    if (!preview.actionId) {
      throw new Error("Missing manual action");
    }
    await advanceLedgerAction(context.db, "owner", preview.actionId);
    await advanceLedgerAction(context.db, "owner", preview.actionId);
    await advanceLedgerAction(context.db, "owner", preview.actionId);
    expect(venue.entryCalls).toBe(1);
    const [action] = await context.db
      .select()
      .from(executionActions)
      .where(eq(executionActions.id, preview.actionId));
    expect(action?.status).toBe("settled");
  });
  it("requires an explicit protective stop before quoting an opening trade", async () => {
    await expect(
      quoteManualTrade(context.db, "owner", {
        requestId: crypto.randomUUID(),
        source: "perps",
        intent: { ...intent, stopLossPrice: null },
      }),
    ).rejects.toThrow();
    expect(venue.entryCalls).toBe(0);
  });
});
