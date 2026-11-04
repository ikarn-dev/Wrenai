import { testDatabase } from "@tests/server/db/test-database";
import fixture from "@tests/server/execution/oneclick-intent.fixture.json";
import type { AppDatabase } from "@/server/db/client";
import { delegatedKeys } from "@/server/db/schema";
import { generatedIntentSchema } from "@/server/execution/intents-payload";
import type { PreparedIntentsOrder } from "@/server/execution/intents-quote";
import { beginInventorySync, finishInventorySync } from "@/server/execution/inventory";
import type { ManualSpotIntent } from "@/shared/manual-trading";

export const inputAssetId = "nep141:usdc.test-fixture.near",
  outputAssetId = "nep141:wrap.near";
export function manualIntent(amount = "10"): ManualSpotIntent {
  return {
    kind: "spot",
    inputAssetId,
    outputAssetId,
    amount,
    balance: "confidential",
    slippageBps: 50,
    maximumFeeBps: 0,
  };
}
export async function manualContext(): Promise<Awaited<ReturnType<typeof testDatabase>>> {
  const context = await testDatabase();
  await context.db.insert(delegatedKeys).values({
    userId: "owner",
    publicKey: "ed25519:offline-manual-key",
    sealedSecret: Buffer.alloc(60),
    createdAt: Date.now(),
    activatedAt: Date.now(),
    activatedAtBlock: 1,
  });
  await observeManual(context.db);
  return context;
}
export async function observeManual(db: AppDatabase, cash = "100000000", output = "0"): Promise<void> {
  const syncToken = await beginInventorySync(db, "owner", "confidential");
  await finishInventorySync(db, "owner", {
    scope: "confidential",
    syncToken,
    balances: [
      { assetId: inputAssetId, amountUnits: cash },
      { assetId: outputAssetId, amountUnits: output },
    ],
  });
}
export function preparedManualOrder(units = "10000000"): PreparedIntentsOrder {
  const now = Date.now(),
    deadline = new Date(now + 60000).toISOString();
  return {
    quote: {
      provider: "oneclick",
      scope: "confidential",
      inputAssetId,
      outputAssetId,
      inputUnits: units,
      outputUnits: "2000000000000000000000000",
      minOutputUnits: "1990000000000000000000000",
      inputMicroUsd: units,
      outputMicroUsd: units,
      slippageBps: 50,
      appFeeBps: 0,
      capturedAt: now,
      expiresAt: now + 60000,
      quoteHash: "a".repeat(64),
      recipient: "owner.near",
      refundTo: "owner.near",
      feeNote: "Offline quote",
    },
    providerQuote: { quoteRequest: { deadline }, quote: { deadline } },
    depositAddress: "a".repeat(64),
    generated: generatedIntentSchema.parse(fixture.generated),
    payloadHash: "b".repeat(64),
  };
}
