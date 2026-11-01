import "server-only";
import { z } from "zod";
import { callViewFunction } from "@/server/near/rpc";
import { INTENTS_CONTRACT_ID } from "@/shared/intents";

export interface KeyRegistration {
  readonly registered: boolean;
  /** Final block the answer was read at. */
  readonly blockHeight: number;
}

/**
 * Whether intents.near accepts signatures from `publicKey` for `accountId` (Verifier `has_public_key`).
 * For an implicit account its own key always counts; other keys, ours included, must be added by the account.
 */
export async function readKeyRegistration(accountId: string, publicKey: string): Promise<KeyRegistration> {
  const { value, blockHeight } = await callViewFunction(INTENTS_CONTRACT_ID, "has_public_key", {
    account_id: accountId,
    public_key: publicKey,
  });
  const registered = z.boolean().safeParse(value);
  if (!registered.success) {
    throw new Error(`${INTENTS_CONTRACT_ID}.has_public_key returned something other than a boolean`);
  }
  return { registered: registered.data, blockHeight };
}
