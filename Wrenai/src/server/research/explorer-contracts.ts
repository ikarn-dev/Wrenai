import { createHash } from "node:crypto";
import { z } from "zod";
import { ExecutionError } from "@/server/execution/contracts";
import { tokenUnitsSchema } from "@/shared/token-units";

// https://docs.near-intents.org/api-reference/get-transactions
export const publicSwapSchema = z.object({
  originAsset: z
    .string()
    .max(180)
    .regex(/^nep141:[^\s:*]+$/),
  destinationAsset: z
    .string()
    .max(180)
    .regex(/^nep141:[^\s:*]+$/),
  depositAddress: z.string().min(1).max(256),
  depositMemo: z
    .string()
    .max(256)
    .nullish()
    .transform((value) => value ?? null),
  status: z.enum(["SUCCESS", "FAILED", "INCOMPLETE_DEPOSIT", "PENDING_DEPOSIT", "PROCESSING", "REFUNDED"]),
  createdAt: z.iso.datetime(),
  intentHashes: z.string().max(4096),
  amountIn: tokenUnitsSchema,
  amountOut: tokenUnitsSchema,
  senders: z.array(z.string().min(1).max(128)).max(32),
  originChainTxHashes: z.array(z.string().min(1).max(256)).max(32),
  depositType: z.enum(["ORIGIN_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"]),
  recipientType: z.enum(["DESTINATION_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"]),
});
export type PublicSwap = z.infer<typeof publicSwapSchema>;

export class ExplorerFeedPending extends ExecutionError {
  constructor() {
    super("conflict", "The shared public activity feed is waiting for its next request window.");
  }
}
export const publicFeedSchema = z.strictObject({
  capturedAt: z.number().int().nonnegative(),
  swaps: z.array(publicSwapSchema).max(1000),
});
export type PublicSwapFeed = z.infer<typeof publicFeedSchema>;
export const copyEvidenceSchema = z.strictObject({
  eventId: z.string().regex(/^[a-f0-9]{64}$/),
  event: publicSwapSchema,
});

export function copyEventId(event: PublicSwap): string {
  return createHash("sha256")
    .update(JSON.stringify(["1click-public-swap:v1", event.depositAddress, event.depositMemo]))
    .digest("hex");
}

export function confirmedPublicLeaderSwap(event: PublicSwap, leader: string): boolean {
  return (
    event.status === "SUCCESS" &&
    event.depositType === "ORIGIN_CHAIN" &&
    event.recipientType !== "CONFIDENTIAL_INTENTS" &&
    event.senders.length === 1 &&
    event.senders[0] === leader &&
    event.originChainTxHashes.length > 0 &&
    event.intentHashes.length > 0 &&
    event.originAsset !== event.destinationAsset &&
    BigInt(event.amountIn) > 0n &&
    BigInt(event.amountOut) > 0n
  );
}
