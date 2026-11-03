import "server-only";
import { z } from "zod";
import { callViewFunction, viewNearBalance } from "@/server/near/rpc";
import { intentTokens } from "@/server/research/intents";
import type { AgentInstruction } from "@/shared/agent-instructions";
import { ExecutionError } from "./contracts";

/** The payout stays on NEAR. A registry entry for an external-chain representation is not a NEAR-wallet route. */
export async function assertPublicPaymentRecipient(
  instruction: Extract<AgentInstruction, { kind: "private_payments" }>,
): Promise<void> {
  if (instruction.destination !== "near_wallet") {
    return;
  }
  const results = await Promise.allSettled([intentTokens(), viewNearBalance(instruction.recipient)]);
  const registry = results[0],
    account = results[1];
  if (registry?.status !== "fulfilled" || account?.status !== "fulfilled" || account.value === null) {
    throw new ExecutionError(
      "not_ready",
      "The public NEAR recipient or supported token route could not be verified.",
    );
  }
  const matches = registry.value.tokens.filter((candidate) => candidate.assetId === instruction.assetId),
    token = matches[0];
  if (matches.length !== 1 || !token || token.blockchain.toLowerCase() !== "near") {
    throw new ExecutionError(
      "not_ready",
      "Choose a verified NEAR-native payout asset for a public NEAR recipient.",
    );
  }
  const contract = instruction.assetId.slice("nep141:".length);
  if (instruction.assetId === "nep141:wrap.near") {
    if (token.decimals !== 24) {
      throw new ExecutionError("not_ready", "The managed NEAR payout token precision changed.");
    }
    return;
  }
  const reads = await Promise.allSettled([
    callViewFunction(contract, "ft_metadata", {}),
    callViewFunction(contract, "storage_balance_of", { account_id: instruction.recipient }),
  ]);
  const metadata = reads[0],
    storage = reads[1];
  if (metadata?.status !== "fulfilled" || storage?.status !== "fulfilled") {
    throw new ExecutionError(
      "not_ready",
      "The payout token or recipient storage registration could not be checked.",
    );
  }
  const meta = z
    .object({ spec: z.literal("ft-1.0.0"), decimals: z.number().int().min(0).max(36) })
    .parse(metadata.value.value);
  const balance = z
    .object({ total: z.string().regex(/^\d+$/), available: z.string().regex(/^\d+$/) })
    .nullable()
    .parse(storage.value.value);
  if (meta.decimals !== token.decimals || balance === null || BigInt(balance.total) === 0n) {
    throw new ExecutionError(
      "not_ready",
      "Register the recipient for this exact NEAR token before creating its public payout.",
    );
  }
}
