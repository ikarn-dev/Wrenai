import "server-only";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { delegatedKeys, users } from "@/server/db/schema";
import { readKeyRegistration } from "@/server/intents/verifier";
import { activeTradingAccount, tradingAccountSigningKeys } from "@/server/trading-accounts/vault";
import { ExecutionError } from "../contracts";
import type { RheaPrepared } from "./contracts";

export async function nativeAuthority(
  db: AppDatabase,
  userId: string,
  prepared: RheaPrepared,
): Promise<Awaited<ReturnType<typeof tradingAccountSigningKeys>>["native"]> {
  const root = await activeTradingAccount(db, userId);
  const [key] = await db.select().from(delegatedKeys).where(eq(delegatedKeys.userId, userId)).limit(1);
  const [owner] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (
    !root?.backupConfirmedAt ||
    root.id !== prepared.rootId ||
    root.nativeAccountId !== prepared.accountId ||
    !key?.activatedAt ||
    !key.activatedAtBlock ||
    !owner
  ) {
    throw new ExecutionError(
      "not_ready",
      "The shared authorization or backed-up native account is unavailable.",
    );
  }
  const registration = await readKeyRegistration(owner.accountId, key.publicKey);
  if (!registration.registered || registration.blockHeight < key.activatedAtBlock) {
    throw new ExecutionError("not_ready", "Trading access was revoked or could not be verified.");
  }
  return (await tradingAccountSigningKeys(db, userId, root.id)).native;
}
