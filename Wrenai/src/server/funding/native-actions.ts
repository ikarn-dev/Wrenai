"use server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { currentUser, type SessionUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { nativeDeposits } from "@/server/db/native-funding-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { ExecutionError } from "@/server/execution/contracts";
import { consumeRateLimit } from "@/server/http/rate-limit";
import type { TradingResult } from "@/shared/manual-trading";
import type { NativeFundingView } from "@/shared/native-funding";
import { beginNativeFunding, proveNativeFunding } from "./native-lifecycle";
import { prepareNativeFunding } from "./native-prepare";
import { activeNativeFunding, ownedNativeFunding } from "./native-records";

async function nativeFundingAction<T>(run: (user: SessionUser) => Promise<T>): Promise<TradingResult<T>> {
  const user = await currentUser();
  if (!user) {
    return { ok: false, code: "signed_out", message: "Sign in to fund your trading account." };
  }
  if ((await consumeRateLimit(`native-funding:${user.id}`, 30, 60_000)) !== "allowed") {
    return { ok: false, code: "rate_limited", message: "Wait a moment before checking funding again." };
  }
  try {
    return { ok: true, value: await run(user) };
  } catch (error) {
    if (error instanceof ExecutionError) {
      return { ok: false, code: error.code, message: error.message };
    }
    if (error instanceof z.ZodError) {
      return { ok: false, code: "invalid_input", message: "Check the funding amount and transaction hash." };
    }
    return {
      ok: false,
      code: "unavailable",
      message: "Funding could not be confirmed. Keep the transaction hash and check it before sending again.",
    };
  }
}
export async function reviewNativeFunding(raw: unknown): Promise<TradingResult<NativeFundingView>> {
  return nativeFundingAction((user) => prepareNativeFunding(database(), user, raw));
}
export async function readNativeFunding(): Promise<TradingResult<NativeFundingView | null>> {
  return nativeFundingAction((user) => activeNativeFunding(database(), user.id));
}
export async function startNativeFundingStep(raw: unknown): Promise<TradingResult<NativeFundingView>> {
  return nativeFundingAction((user) => beginNativeFunding(database(), user, raw));
}
export async function confirmNativeFundingStep(raw: unknown): Promise<TradingResult<NativeFundingView>> {
  return nativeFundingAction((user) => proveNativeFunding(database(), user, raw));
}
export async function cancelNativeFunding(raw: unknown): Promise<TradingResult<null>> {
  return nativeFundingAction(async (user) => {
    const input = z
      .strictObject({ id: z.uuid(), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(raw);
    await userTransaction(database(), user.id, async (tx) => {
      const row = await ownedNativeFunding(tx, user.id, input.id);
      if (row.state !== "prepared" || row.snapshotHash !== input.snapshotHash) {
        throw new ExecutionError("conflict", "An attempted transfer must be verified, not dismissed.");
      }
      await tx
        .update(nativeDeposits)
        .set({ state: "cancelled" })
        .where(and(eq(nativeDeposits.id, row.id), eq(nativeDeposits.userId, user.id)));
    });
    return null;
  });
}
