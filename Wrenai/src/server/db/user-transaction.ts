import "server-only";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "./client";
import { users } from "./schema";

/** Serializes an owner's mutations across functions; do not perform external I/O while holding this lock. */
export async function userTransaction<T>(
  db: AppDatabase,
  userId: string,
  run: (tx: AppDatabase) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    if (owner === undefined) {
      throw new Error("The signed-in account no longer exists.");
    }
    return run(tx);
  });
}
