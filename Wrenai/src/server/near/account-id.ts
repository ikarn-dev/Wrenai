import { z } from "zod";

// Account ID rules: https://docs.near.org/protocol/account-id
const ACCOUNT_ID_PATTERN = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_ACCOUNT_PATTERN = /^[0-9a-f]{64}$/;

export const nearAccountIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(ACCOUNT_ID_PATTERN, "Not a valid NEAR account ID");

/** A NEAR implicit account is the hex encoding of its ed25519 public key. */
export function isImplicitAccountId(accountId: string): boolean {
  return IMPLICIT_ACCOUNT_PATTERN.test(accountId);
}
