import "server-only";
import { randomUUID } from "node:crypto";
import { KeyPairEd25519 } from "@near-js/crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Wallet } from "ethers";
import { z } from "zod";
import { chatCipher } from "@/server/chat/cipher";
import type { AppDatabase } from "@/server/db/client";
import { tradingAccounts } from "@/server/db/trading-account-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "@/server/execution/contracts";
import { databaseTime } from "@/server/execution/records";
import { parseEd25519PublicKey } from "@/server/near/nep413";
import {
  nearRecoveryKeySchema,
  PERPS_DERIVATION,
  type RecoveryPayload,
  recoveryPayloadSchema,
  type TradingAccountSummary,
} from "@/shared/trading-recovery";

const keysSchema = z.strictObject({
  near: nearRecoveryKeySchema,
  perps: z.string().regex(/^0x[a-f0-9]{64}$/),
});
type TradingAccount = typeof tradingAccounts.$inferSelect;

export async function activeTradingAccount(db: AppDatabase, userId: string): Promise<TradingAccount | null> {
  const [row] = await db
    .select()
    .from(tradingAccounts)
    .where(and(eq(tradingAccounts.userId, userId), isNull(tradingAccounts.revokedAt)))
    .limit(1);
  return row ?? null;
}
/** Called only after a fresh ownership signature, inside the owner transaction. No account is funded here. */
export async function ensureTradingAccount(db: AppDatabase, userId: string): Promise<TradingAccount> {
  const existing = await activeTradingAccount(db, userId);
  if (existing) {
    return existing;
  }
  const native = KeyPairEd25519.fromRandom();
  const perps = Wallet.createRandom();
  const nativePublicKey = native.getPublicKey().toString();
  const publicBytes = parseEd25519PublicKey(nativePublicKey);
  if (!publicBytes) {
    throw new ExecutionError("not_ready", "The native trading identity could not be generated.");
  }
  const id = randomUUID();
  const sealedKeys = chatCipher().seal(
    userId,
    `trading-account:${id}`,
    "private-keys",
    JSON.stringify({ near: native.toString(), perps: perps.privateKey }),
  );
  const [row] = await db
    .insert(tradingAccounts)
    .values({
      id,
      userId,
      nativePublicKey,
      nativeAccountId: Buffer.from(publicBytes).toString("hex"),
      perpAddress: perps.address,
      sealedKeys,
      createdAt: await databaseTime(db),
    })
    .returning();
  if (!row) {
    throw new ExecutionError("not_ready", "The unfunded trading account could not be saved.");
  }
  return row;
}

function accountKeys(account: TradingAccount): z.infer<typeof keysSchema> {
  if (account.revokedAt !== null || account.sealedKeys === null) {
    throw new ExecutionError("not_ready", "This trading account was revoked.");
  }
  try {
    const keys = keysSchema.parse(
      JSON.parse(
        chatCipher().open(
          account.userId,
          `trading-account:${account.id}`,
          "private-keys",
          account.sealedKeys,
        ),
      ),
    );
    const near = new KeyPairEd25519(keys.near.slice("ed25519:".length));
    const bytes = parseEd25519PublicKey(near.getPublicKey().toString());
    if (
      !bytes ||
      near.getPublicKey().toString() !== account.nativePublicKey ||
      Buffer.from(bytes).toString("hex") !== account.nativeAccountId ||
      new Wallet(keys.perps).address !== account.perpAddress
    ) {
      throw new Error("Account identity mismatch");
    }
    return keys;
  } catch {
    throw new ExecutionError("not_ready", "The encrypted trading identity could not be verified.");
  }
}

/** Fresh owner-proof export only; the shared Intents authorization secret is never included. */
export function tradingRecoveryPayload(account: TradingAccount, ownerAccountId: string): RecoveryPayload {
  const keys = accountKeys(account);
  return recoveryPayloadSchema.parse({
    format: "wrenai-trading-recovery-v2",
    network: "mainnet",
    ownerAccountId,
    accountId: account.id,
    createdAt: account.createdAt,
    native: { accountId: account.nativeAccountId, publicKey: account.nativePublicKey, privateKey: keys.near },
    perps: {
      venue: "hyperliquid",
      address: account.perpAddress,
      privateKey: keys.perps,
      derivation: PERPS_DERIVATION,
    },
  });
}

/** The Signer cannot use a trading key until the owner confirms the downloaded encrypted backup. */
export async function tradingAccountSigningKeys(
  db: AppDatabase,
  userId: string,
  accountId: string,
): Promise<{ readonly native: KeyPairEd25519; readonly perps: Wallet }> {
  const account = await activeTradingAccount(db, userId);
  if (!account || account.id !== accountId || account.backupConfirmedAt === null) {
    throw new ExecutionError(
      "not_ready",
      "Confirm your recovery backup before funding or activating this account.",
    );
  }
  const keys = accountKeys(account);
  return { native: new KeyPairEd25519(keys.near.slice("ed25519:".length)), perps: new Wallet(keys.perps) };
}

export async function tradingAccountSummary(
  db: AppDatabase,
  userId: string,
): Promise<TradingAccountSummary | null> {
  const row = await activeTradingAccount(db, userId);
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    nativeAccountId: row.nativeAccountId,
    perpAddress: row.perpAddress,
    backupConfirmed: row.backupConfirmedAt !== null,
    derivedBackupConfirmed: row.backupConfirmedAt !== null && row.backupVersion >= 2,
  };
}

export async function revokeTradingAccounts(db: AppDatabase, userId: string): Promise<void> {
  await userTransaction(db, userId, async (tx) => {
    await tx
      .update(tradingAccounts)
      .set({ revokedAt: await databaseTime(tx), sealedKeys: null })
      .where(and(eq(tradingAccounts.userId, userId), isNull(tradingAccounts.revokedAt)));
  });
}
