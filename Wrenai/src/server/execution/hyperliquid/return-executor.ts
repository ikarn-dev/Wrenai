import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { executionEvents } from "@/server/db/execution-schema";
import { delegatedKeys } from "@/server/db/schema";
import { agentTradingAccounts } from "@/server/db/trading-account-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { manualReturnSource } from "@/server/manual-trading/return-source";
import { activeTradingAccount } from "@/server/trading-accounts/vault";
import { type HlUsdSend, hlUsdSendSchema } from "@/shared/perps-return";
import { ExecutionError } from "../contracts";
import { defiPlanSchema } from "../defi-contracts";
import { commitSignedExecution, recordSubmissionStatus } from "../ownership";
import { synchronizePrivateInventory } from "../private-inventory";
import {
  databaseTime,
  executionEvent,
  executionHash,
  type LedgerAction,
  ownedLedgerAction,
} from "../records";
import { hlUnits } from "./decimal";
import { perpsAuthority } from "./journal";
import { readReturnRecord, returnTransferTemplate, validateReturnPlan } from "./return-record";
import { ownedReturnSource, requireClosedReturnVenue } from "./return-source";
import { signHlTransfer } from "./signing";
import { hlTransfer } from "./transport";

export async function signedReturnRequest(db: AppDatabase, action: LedgerAction): Promise<HlUsdSend | null> {
  const rows = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.userId, action.userId),
        eq(executionEvents.actionId, action.id),
        eq(executionEvents.kind, "perps_return_signed"),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    throw new ExecutionError("conflict", "Competing return requests require manual review.");
  }
  return rows[0] ? hlUsdSendSchema.parse(JSON.parse(rows[0].detailJson)) : null;
}
export async function executePerpsReturn(
  db: AppDatabase,
  userId: string,
  actionId: string,
  lease: string,
): Promise<void> {
  const ledger = await ownedLedgerAction(db, userId, actionId),
    plan = defiPlanSchema.parse(JSON.parse(ledger.planJson)),
    saved = await readReturnRecord(db, ledger);
  validateReturnPlan(plan, saved, Date.now());
  if (ledger.status !== "reserved" || ledger.kind !== "defi") {
    throw new ExecutionError("conflict", "Only an unsent return can be signed.");
  }
  const [venue, authority] = await Promise.all([
    requireClosedReturnVenue(db, userId, ledger.agentId),
    perpsAuthority(db, userId, ledger.agentId),
    synchronizePrivateInventory(db, userId),
  ]);
  const result = await userTransaction(db, userId, async (tx) => {
    const current = await ownedLedgerAction(tx, userId, actionId);
    if (await signedReturnRequest(tx, current)) {
      throw new ExecutionError(
        "conflict",
        "This return already has signing bytes. Reconcile it without resending.",
      );
    }
    const { account } = await (ledger.origin === "manual" ? manualReturnSource : ownedReturnSource)(
        tx,
        userId,
        ledger.agentId,
        actionId,
      ),
      root = await activeTradingAccount(tx, userId);
    const [key] = await tx.select().from(delegatedKeys).where(eq(delegatedKeys.userId, userId)).limit(1);
    const now = await databaseTime(tx);
    if (
      !root ||
      root.id !== saved.rootId ||
      account.perpAddress !== saved.address ||
      authority.wallet.address !== saved.address ||
      !key?.activatedAt ||
      key.publicKey !== authority.sharedPublicKey ||
      key.activatedAtBlock !== authority.activatedAtBlock ||
      current.signingPublicKey !== key.publicKey ||
      now - venue.time >= 15_000 ||
      venue.time > now + 1000 ||
      hlUnits(venue.crossMarginSummary.totalRawUsd, 6, "down") !== BigInt(saved.beforeCashUnits) ||
      hlUnits(venue.withdrawable, 6, "down") < BigInt(saved.debitUnits)
    ) {
      throw new ExecutionError(
        "not_ready",
        "The return balance, backed-up account or authorization changed before signing.",
      );
    }
    const nonce = Math.max(now, account.lastNonce + 1);
    if (nonce > now + 1000) {
      throw new ExecutionError("not_ready", "A fresh venue nonce is unavailable.");
    }
    const request = hlUsdSendSchema.parse({ ...returnTransferTemplate(saved), time: nonce });
    const signature = await commitSignedExecution(
      tx,
      userId,
      actionId,
      lease,
      { payloadHash: executionHash(returnTransferTemplate(saved)), providerRequestId: randomUUID() },
      () => Buffer.from(JSON.stringify(signHlTransfer(authority.wallet, request))),
    );
    await tx
      .update(agentTradingAccounts)
      .set({ lastNonce: nonce })
      .where(and(eq(agentTradingAccounts.userId, userId), eq(agentTradingAccounts.agentId, ledger.agentId)));
    await executionEvent(tx, current, "perps_return_signed", now, request);
    return { request, signature };
  });
  try {
    const signature = z
      .strictObject({
        r: z.string().regex(/^0x[a-f0-9]{64}$/),
        s: z.string().regex(/^0x[a-f0-9]{64}$/),
        v: z.union([z.literal(27), z.literal(28)]),
      })
      .parse(JSON.parse(result.signature.toString("utf8")));
    const response = await hlTransfer(result.request, signature);
    await userTransaction(db, userId, async (tx) => {
      await executionEvent(tx, ledger, "perps_return_ack", await databaseTime(tx), response);
    });
    z.object({ status: z.literal("ok"), response: z.object({ type: z.literal("default") }) }).parse(response);
    await recordSubmissionStatus(db, userId, actionId, lease, "submitted");
  } catch {
    // User-signed transfers have no expiry. No error or lost acknowledgement proves they are safe to resend.
    await recordSubmissionStatus(db, userId, actionId, lease, "unknown");
  } finally {
    result.signature.fill(0);
  }
}
