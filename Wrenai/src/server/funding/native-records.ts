import "server-only";
import { and, eq, notInArray } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { nativeDeposits } from "@/server/db/native-funding-schema";
import { ExecutionError } from "@/server/execution/contracts";
import { executionHash } from "@/server/execution/records";
import { type NativeFundingView, nativeFundingSnapshotSchema } from "@/shared/native-funding";

export function nativeFundingView(row: typeof nativeDeposits.$inferSelect): NativeFundingView {
  const snapshot = nativeFundingSnapshotSchema.parse(JSON.parse(row.snapshotJson));
  if (
    snapshot.id !== row.id ||
    snapshot.userId !== row.userId ||
    snapshot.subjectId !== row.subjectId ||
    row.snapshotHash !== executionHash(snapshot)
  ) {
    throw new ExecutionError("conflict", "The native funding review changed.");
  }
  return {
    id: row.id,
    state: row.state,
    snapshot,
    snapshotHash: row.snapshotHash,
    expiresAt: row.expiresAt,
    gasHash: row.gasHash,
    tokenHash: row.tokenHash,
  };
}
export async function ownedNativeFunding(
  db: AppDatabase,
  userId: string,
  id: string,
): Promise<typeof nativeDeposits.$inferSelect> {
  const [row] = await db
    .select()
    .from(nativeDeposits)
    .where(and(eq(nativeDeposits.id, id), eq(nativeDeposits.userId, userId)))
    .limit(1);
  if (!row) {
    throw new ExecutionError("not_found", "This native funding request is unavailable.");
  }
  nativeFundingView(row);
  return row;
}
export async function activeNativeFunding(
  db: AppDatabase,
  userId: string,
): Promise<NativeFundingView | null> {
  const [row] = await db
    .select()
    .from(nativeDeposits)
    .where(
      and(eq(nativeDeposits.userId, userId), notInArray(nativeDeposits.state, ["complete", "cancelled"])),
    )
    .limit(1);
  return row ? nativeFundingView(row) : null;
}
export function nativeFundingHeldUnits(pending: NativeFundingView | null, assetId: string): bigint {
  if (!pending) {
    return 0n;
  }
  const s = pending.snapshot;
  const tokenPending = pending.state !== "complete" && pending.state !== "cancelled";
  return (
    (assetId === "native:near" && (pending.state === "prepared" || pending.state === "gas_pending")
      ? BigInt(s.gasUnits)
      : 0n) +
    (assetId === "native:near" && tokenPending ? BigInt(s.registrationUnits) : 0n) +
    (s.agentId === null && s.sourceAssetId === assetId && tokenPending ? BigInt(s.units) : 0n)
  );
}
