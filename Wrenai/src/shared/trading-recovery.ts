import { base58 } from "@scure/base";
import { z } from "zod";

export const nearRecoveryKeySchema = z
  .string()
  .max(100)
  .regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/)
  .pipe(
    z.string().refine((value) => {
      try {
        return base58.decode(value.slice("ed25519:".length)).length === 64;
      } catch {
        return false;
      }
    }, "A NEAR recovery key must contain a 64-byte extended key."),
  );

const recoveryPayloadV1Schema = z.strictObject({
  format: z.literal("wrenai-trading-recovery-v1"),
  network: z.literal("mainnet"),
  ownerAccountId: z.string().min(2).max(64),
  accountId: z.uuid(),
  createdAt: z.number().int().nonnegative(),
  native: z.strictObject({
    accountId: z.string().regex(/^[a-f0-9]{64}$/),
    publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/),
    privateKey: nearRecoveryKeySchema,
  }),
  perps: z.strictObject({
    venue: z.literal("hyperliquid"),
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    privateKey: z.string().regex(/^0x[a-f0-9]{64}$/),
  }),
});
export const PERPS_DERIVATION = {
  scheme: "bip32-secp256k1",
  seedSource: "perps.privateKey",
  pathPrefix: "m/44'/60'/0'/0",
  firstIndex: 0,
  addressCount: 1000,
} as const;
export const recoveryPayloadSchema = z.union([
  recoveryPayloadV1Schema,
  recoveryPayloadV1Schema.extend({
    format: z.literal("wrenai-trading-recovery-v2"),
    perps: recoveryPayloadV1Schema.shape.perps.extend({
      derivation: z.strictObject({
        scheme: z.literal(PERPS_DERIVATION.scheme),
        seedSource: z.literal(PERPS_DERIVATION.seedSource),
        pathPrefix: z.literal(PERPS_DERIVATION.pathPrefix),
        firstIndex: z.literal(0),
        addressCount: z.literal(PERPS_DERIVATION.addressCount),
      }),
    }),
  }),
]);
export type RecoveryPayload = z.infer<typeof recoveryPayloadSchema>;
export const recoveryEnvelopeSchema = z.strictObject({
  format: z.literal("wrenai-encrypted-recovery-v1"),
  kdf: z.literal("PBKDF2-SHA256"),
  iterations: z.literal(600000),
  salt: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ciphertext: z
    .string()
    .min(22)
    .max(32_000)
    .regex(/^[A-Za-z0-9_-]+$/),
});
const recoveryContext = { agentId: z.uuid().optional(), manual: z.literal(true).optional() };
export const recoveryRequestSchema = z
  .strictObject(recoveryContext)
  .refine(
    (v) => (v.agentId !== undefined) !== (v.manual === true),
    "Choose a saved agent or manual trading.",
  );
export const recoverySignatureSchema = z
  .strictObject({
    ...recoveryContext,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    publicKey: z.string().max(128),
    signature: z.string().max(256),
  })
  .refine(
    (v) => (v.agentId !== undefined) !== (v.manual === true),
    "Choose a saved agent or manual trading.",
  );
export const recoveryConfirmationSchema = z.strictObject({
  accountId: z.uuid(),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export interface RecoveryChallenge {
  readonly nonce: string;
  readonly message: string;
  readonly recipient: string;
}
export interface RecoveryExport {
  readonly payload: RecoveryPayload;
  readonly confirmationToken: string;
}
export interface TradingAccountSummary {
  readonly id: string;
  readonly nativeAccountId: string;
  readonly perpAddress: string;
  readonly backupConfirmed: boolean;
  readonly derivedBackupConfirmed?: boolean;
}
