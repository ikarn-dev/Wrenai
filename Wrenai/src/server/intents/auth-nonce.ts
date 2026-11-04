import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { versionedNonce } from "@/server/execution/confidential-intents";
import { callViewFunction } from "@/server/near/rpc";
import { INTENTS_CONTRACT_ID } from "@/shared/intents";

const saltSchema = z.string().regex(/^[0-9a-f]{8}$/);

/**
 * A fresh nonce for a NEP-413 login to 1Click (recipient intents.near), bound to `deadlineMs`. Reads the
 * contract's current salt at final finality, since the contract can rotate it and old salts stop being accepted.
 */
export async function intentsLoginNonce(deadlineMs: number, signal?: AbortSignal): Promise<Buffer> {
  const { value } = await callViewFunction(INTENTS_CONTRACT_ID, "current_salt", {}, signal);
  const salt = Buffer.from(saltSchema.parse(value), "hex");
  return versionedNonce(salt, deadlineMs, Date.now(), randomBytes(7));
}
