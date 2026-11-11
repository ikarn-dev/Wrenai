"use client";

import { z } from "zod";
import { nearClaimTransaction } from "@/shared/portfolio-wallet";

// NEAR wallets answer with the final outcome; a failed receipt still returns a hash, so its status is checked.
const failedOutcome = z.object({ status: z.object({ Failure: z.unknown() }) });

export type UnwrapResult =
  | { readonly kind: "claimed"; readonly hash: string }
  | { readonly kind: "cancelled" };

/** Unwraps `units` of the owner's wNEAR to native NEAR with wrap.near's `near_withdraw`, signed in their wallet. */
export async function unwrapNear(accountId: string, units: string): Promise<UnwrapResult> {
  const [{ walletForAccount }, { walletNotice }, { walletTransactionHash }] = await Promise.all([
    import("@/components/wallet/near-connector"),
    import("@/components/wallet/notices"),
    import("@/components/wallet/transaction-hash"),
  ]);
  const wallet = await walletForAccount(accountId, "authorize", () => {});
  if (!wallet.ok) {
    throw new Error(wallet.notice.text);
  }
  const transaction = nearClaimTransaction(accountId, units);
  let reply: unknown;
  try {
    reply = await wallet.value.signAndSendTransaction({ ...transaction, actions: [...transaction.actions] });
  } catch (error) {
    const notice = walletNotice(error, "authorize");
    if (notice.tone === "info") {
      return { kind: "cancelled" };
    }
    throw new Error(notice.text);
  }
  if (failedOutcome.safeParse(reply).success) {
    throw new Error("The unwrap failed on NEAR. Your wNEAR is unchanged.");
  }
  return { kind: "claimed", hash: walletTransactionHash.parse(reply) };
}
