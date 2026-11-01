import { createHash } from "node:crypto";
import { parse } from "lossless-json";
import { z } from "zod";
import { positiveTokenUnitsSchema } from "@/shared/token-units";
import { privateNonceMatches, privateTokenId } from "./confidential-intents";
import { ExecutionError, hashSchema } from "./contracts";

const text = z.string().min(1).max(256);
// Provider returns a deadline 72 hours after the requested refund deadline. Submission itself still expires in 15s.
export const MAX_PROVIDER_INTENT_VALIDITY_MS = 72 * 3_600_000 + 300_000;
export const generatedIntentSchema = z.strictObject({
  intent: z.strictObject({
    standard: z.literal("nep413"),
    payload: z.strictObject({
      message: z.string().min(1).max(16_000),
      nonce: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
      recipient: z.enum(["intents.near", "intents.far"]),
      callbackUrl: z.null().optional(),
    }),
  }),
  correlationId: text,
});
export type GeneratedIntent = z.infer<typeof generatedIntentSchema>;
export const intentBindingSchema = z.strictObject({
  signerId: z.string().min(2).max(64),
  scope: z.enum(["intents", "confidential"]),
  depositAddress: z.string().regex(/^[a-f0-9]{64}$/),
  inputAssetId: z
    .string()
    .max(180)
    .regex(/^nep141:[^\s:*]+$/),
  inputUnits: positiveTokenUnitsSchema,
  providerDeadline: z.iso.datetime(),
  maximumValidityMs: z.number().int().positive().max(MAX_PROVIDER_INTENT_VALIDITY_MS),
  now: z.number().int().nonnegative(),
});

const transferMessageSchema = z.strictObject({
  signer_id: z.string().min(2).max(64),
  deadline: z.iso.datetime(),
  intents: z.tuple([
    z.strictObject({
      intent: z.literal("transfer"),
      receiver_id: z.string().regex(/^[a-f0-9]{64}$/),
      tokens: z.record(z.string().min(1).max(256), positiveTokenUnitsSchema),
    }),
  ]),
});

/** Validate exact original bytes; never rewrite a provider-generated intent before signing. */
export function validateGeneratedIntent(
  raw: unknown,
  rawBinding: unknown,
): { readonly intent: GeneratedIntent; readonly payloadHash: string } {
  const binding = intentBindingSchema.parse(rawBinding);
  const generated = generatedIntentSchema.parse(raw);
  const payload = generated.intent.payload;
  const nonce = Buffer.from(payload.nonce, "base64");
  const message = transferMessageSchema.parse(parse(payload.message));
  const transfer = message.intents[0];
  const entries = Object.entries(transfer.tokens);
  const expectedContract = binding.scope === "confidential" ? "intents.far" : "intents.near";
  const deadline = Date.parse(message.deadline);
  const inputTokenId =
    binding.scope === "confidential" ? privateTokenId(binding.inputAssetId) : binding.inputAssetId;
  if (
    nonce.length !== 32 ||
    nonce.toString("base64") !== payload.nonce ||
    payload.recipient !== expectedContract ||
    message.signer_id !== binding.signerId ||
    transfer.receiver_id !== binding.depositAddress ||
    entries.length !== 1 ||
    transfer.tokens[inputTokenId] !== binding.inputUnits ||
    message.deadline !== binding.providerDeadline ||
    (binding.scope === "confidential" && !privateNonceMatches(nonce, deadline))
  ) {
    throw new ExecutionError(
      "conflict",
      "The generated intent changes the approved account, asset, amount or destination.",
    );
  }
  if (deadline <= binding.now || deadline > binding.now + binding.maximumValidityMs) {
    throw new ExecutionError(
      "not_ready",
      "The provider's signing deadline exceeds the allowed authorization lifetime.",
    );
  }
  const payloadHash = hashSchema.parse(
    createHash("sha256").update(JSON.stringify(generated.intent)).digest("hex"),
  );
  return { intent: generated, payloadHash };
}
