import "server-only";
import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, isNull } from "drizzle-orm";
import { stopUserAgents } from "@/server/agents/records";
import type { SessionUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { delegatedKeys } from "@/server/db/schema";
import { userTransaction } from "@/server/db/user-transaction";
import { type KeyRegistration, readKeyRegistration } from "@/server/intents/verifier";
import { NearRpcError } from "@/server/near/rpc";
import { revokeTradingAccounts } from "@/server/trading-accounts/vault";
import { generateAgentKey } from "./agent-key";

export type DelegatedKeyState =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly publicKey: string }
  | { readonly kind: "active"; readonly publicKey: string; readonly activatedAt: number };

export interface DelegatedKeyReading {
  readonly state: DelegatedKeyState;
  /** False when NEAR couldn't be reached and `state` is the last recorded one. */
  readonly checked: boolean;
}

type KeyRow = typeof delegatedKeys.$inferSelect;

const NONE: DelegatedKeyState = { kind: "none" };

// A wallet returns once its transaction executes; reads at final finality see the change a few blocks later.
const SETTLE_ATTEMPTS = 5;
const SETTLE_INTERVAL_MS = 1_500;

async function findKey(userId: string): Promise<KeyRow | undefined> {
  const [row] = await database()
    .select()
    .from(delegatedKeys)
    .where(eq(delegatedKeys.userId, userId))
    .limit(1);
  return row;
}

function toState(row: KeyRow | undefined): DelegatedKeyState {
  if (row === undefined) {
    return NONE;
  }
  return row.activatedAt === null
    ? { kind: "pending", publicKey: row.publicKey }
    : { kind: "active", publicKey: row.publicKey, activatedAt: row.activatedAt };
}

/** The key as last recorded, without asking NEAR. */
export async function storedKeyState(userId: string): Promise<DelegatedKeyState> {
  return toState(await findKey(userId));
}

/** Creates the user's agent key unless one is stored, and returns the stored key's public key. */
export async function ensureAgentKey(userId: string): Promise<string> {
  const existing = await findKey(userId);
  if (existing !== undefined) {
    return existing.publicKey;
  }
  const generated = generateAgentKey();
  // A concurrent request may have stored one first; the primary key keeps exactly one per user.
  await database()
    .insert(delegatedKeys)
    .values({
      userId,
      publicKey: generated.publicKey,
      sealedSecret: generated.sealedSecret,
      createdAt: Date.now(),
      activatedAt: null,
      activatedAtBlock: null,
    })
    .onConflictDoNothing();
  // Only a stored key may be registered: one whose secret isn't saved could never sign.
  const stored = await findKey(userId);
  if (stored === undefined) {
    throw new Error("The agent key was removed while it was being created");
  }
  return stored.publicKey;
}

// RPC nodes can lag one another, so only a block after the one that first showed the key proves it was removed.
function isRemoval(row: KeyRow, reading: KeyRegistration): boolean {
  return row.activatedAtBlock !== null && !reading.registered && reading.blockHeight > row.activatedAtBlock;
}

async function readSettled(
  row: KeyRow,
  accountId: string,
  settled: (reading: KeyRegistration) => boolean,
): Promise<KeyRegistration> {
  let reading = await readKeyRegistration(accountId, row.publicKey);
  for (let attempt = 1; attempt < SETTLE_ATTEMPTS && !settled(reading); attempt += 1) {
    await sleep(SETTLE_INTERVAL_MS);
    reading = await readKeyRegistration(accountId, row.publicKey);
  }
  return reading;
}

async function activate(row: KeyRow, blockHeight: number): Promise<DelegatedKeyState> {
  await database()
    .update(delegatedKeys)
    .set({ activatedAt: Date.now(), activatedAtBlock: blockHeight })
    .where(
      and(
        eq(delegatedKeys.userId, row.userId),
        eq(delegatedKeys.publicKey, row.publicKey),
        isNull(delegatedKeys.activatedAtBlock),
      ),
    );
  return storedKeyState(row.userId);
}

async function deleteKey(row: KeyRow): Promise<void> {
  await userTransaction(database(), row.userId, async (tx) => {
    await stopUserAgents(tx, row.userId, "Stopped because the delegated key was revoked.");
    await revokeTradingAccounts(tx, row.userId);
    await tx
      .delete(delegatedKeys)
      .where(and(eq(delegatedKeys.userId, row.userId), eq(delegatedKeys.publicKey, row.publicKey)));
  });
}

/**
 * Brings the stored key in line with intents.near: a pending key that is registered becomes active, and an active
 * key that is gone was revoked (here or in another app), so it is deleted with its secret. `expect` waits a few
 * seconds for a change the user just sent from their wallet. Throws NearRpcError when NEAR can't be reached.
 */
export async function syncDelegatedKey(
  user: SessionUser,
  expect?: "registered" | "removed",
): Promise<DelegatedKeyState> {
  const row = await findKey(user.id);
  if (row === undefined) {
    return NONE;
  }
  const reading = await readSettled(row, user.accountId, (current) => {
    switch (expect) {
      case undefined:
        return true;
      case "registered":
        return current.registered;
      case "removed":
        return row.activatedAtBlock === null || isRemoval(row, current);
      default: {
        const unhandled: never = expect;
        throw new Error(`Unhandled key expectation: ${String(unhandled)}`);
      }
    }
  });
  if (row.activatedAtBlock === null) {
    return reading.registered ? await activate(row, reading.blockHeight) : toState(row);
  }
  if (isRemoval(row, reading)) {
    await deleteKey(row);
    return NONE;
  }
  return toState(row);
}

/** For pages: the synced key, or the recorded one when NEAR can't be reached. */
export async function readDelegatedKey(user: SessionUser): Promise<DelegatedKeyReading> {
  try {
    return { state: await syncDelegatedKey(user), checked: true };
  } catch (error) {
    if (error instanceof NearRpcError) {
      return { state: await storedKeyState(user.id), checked: false };
    }
    throw error;
  }
}
