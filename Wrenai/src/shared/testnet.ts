import { z } from "zod";
import { testnetAgentToolSchema } from "./testnet-agents";
import { parseTokenAmount, tokenUnitsSchema } from "./token-units";
export const testnetAssetSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  contract: z.string().nullable(),
  decimals: z.number().int().min(0).max(24),
});
export type TestnetAsset = z.infer<typeof testnetAssetSchema>;
export const TESTNET_ASSETS: readonly TestnetAsset[] = [
  { id: "native:near", symbol: "NEAR", contract: null, decimals: 24 },
  ...[
    { symbol: "USDC", decimals: 6 },
    { symbol: "USDT", decimals: 6 },
    { symbol: "wNEAR", decimals: 24 },
    { symbol: "wBTC", decimals: 8 },
    { symbol: "ETH", decimals: 18 },
    { symbol: "XAUT", decimals: 6 },
  ].map((t) => ({
    ...t,
    id: `nep141:${t.symbol.toLowerCase()}.tidepool-sandbox.testnet`,
    contract: `${t.symbol.toLowerCase()}.tidepool-sandbox.testnet`,
  })),
];
export function testnetAsset(id: string): TestnetAsset {
  const token = TESTNET_ASSETS.find((t) => t.id === id);
  if (!token) {
    throw new Error("This token is not supported on this testnet route.");
  }
  return token;
}
export function resolveTestnetAsset(hint: string): TestnetAsset | null {
  const normalized = hint.trim().toLowerCase();
  return (
    TESTNET_ASSETS.find(
      (t) => t.id === normalized || t.contract === normalized || t.symbol.toLowerCase() === normalized,
    ) ?? null
  );
}
export function tokenText(units: string, decimals: number): string {
  const n = tokenUnitsSchema.parse(units).padStart(decimals + 1, "0");
  if (decimals === 0) {
    return n;
  }
  const fraction = n.slice(-decimals).replace(/0+$/, "");
  return `${n.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}
export const testnetLocationSchema = z.enum(["wallet", "intents"]);
export type TestnetLocation = z.infer<typeof testnetLocationSchema>;
export function balanceKey(assetId: string, location: TestnetLocation): string {
  return location === "wallet" ? assetId : `intents:${assetId}`;
}
const amount = z.string().regex(/^(?:0|[1-9]\d{0,18})(?:\.\d{1,24})?$/);
export const testnetIntentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("payment"),
    location: testnetLocationSchema.optional(),
    assetId: z.string(),
    amount,
    recipient: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/),
  }),
  z.strictObject({
    kind: z.literal("swap"),
    location: testnetLocationSchema.optional(),
    outputLocation: testnetLocationSchema.optional(),
    assetId: z.string(),
    outputAssetId: z.string(),
    amount,
    slippageBps: z.number().int().min(1).max(100),
  }),
]);
export type TestnetIntent = z.infer<typeof testnetIntentSchema>;
export const testnetRuleSchema = z.strictObject({
  location: testnetLocationSchema.optional(),
  outputLocation: testnetLocationSchema.optional(),
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["payments", "spot", "dca", "dip", "profit"]),
  assetId: z.string(),
  outputAssetId: z.string().nullable(),
  recipient: z.string().nullable(),
  amount,
  budget: amount,
  intervalSeconds: z.number().int().min(60).max(604800),
  costBasis: amount.nullable(),
  thresholdBps: z.number().int().min(1).max(9000),
  expiresAt: z.number().int().positive().safe(),
});
export type TestnetRule = z.infer<typeof testnetRuleSchema>;
/** A verified NEAR AI strategy review, as the Proof page shows it: the model receipt without its raw evidence. */
export const testnetVerificationSchema = z.strictObject({
  model: z.string().min(1).max(200),
  completionId: z.string().min(1).max(200),
  verifiedAt: z.number().int().positive(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/i),
  responseHash: z.string().regex(/^[a-f0-9]{64}$/i),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/i),
});
export type TestnetVerification = z.infer<typeof testnetVerificationSchema>;
/** The review_agent reply: the parsed rule and its sealed verification, which deploy sends back unchanged. */
export const testnetReviewSchema = z.strictObject({
  rule: testnetRuleSchema,
  review: z.string().min(1).max(4000),
});
export const testnetRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("guest") }),
  z.strictObject({ command: z.literal("challenge") }),
  z.strictObject({
    command: z.literal("connect"),
    nonce: z.string(),
    accountId: z.string(),
    publicKey: z.string(),
    signature: z.string(),
  }),
  z.strictObject({ command: z.literal("logout") }),
  z.strictObject({ command: z.literal("quote"), requestId: z.uuid(), intent: testnetIntentSchema }),
  z.strictObject({ command: z.literal("confirm"), id: z.uuid() }),
  z.strictObject({
    command: z.literal("receipt"),
    id: z.uuid(),
    hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/),
  }),
  z.strictObject({
    command: z.literal("review_agent"),
    setup: z.strictObject({
      tool: testnetAgentToolSchema,
      text: z.string().trim().min(20).max(4000),
      budget: z.strictObject({ assetId: z.string(), amount: z.string(), location: testnetLocationSchema }),
    }),
  }),
  z.strictObject({
    command: z.literal("refine_agent"),
    setup: z.strictObject({
      tool: testnetAgentToolSchema,
      text: z.string().trim().min(20).max(4000),
      budgetAssetId: z.string().max(80).nullable(),
      budgetAmount: z
        .string()
        .regex(/^(?:\d{1,19}(?:\.\d{1,24})?)?$/)
        .nullable(),
    }),
  }),
  z.strictObject({
    command: z.literal("agent"),
    requestId: z.uuid(),
    rule: testnetRuleSchema,
    /** The sealed verification the review returned for this exact rule; the server opens it, never trusts it. */
    review: z.string().min(1).max(4000).optional(),
  }),
  z.strictObject({ command: z.literal("stop"), id: z.uuid() }),
  // Like mainnet: restart a stopped agent, delete it (its funds wait in Claims), and claim its funds back.
  z.strictObject({ command: z.literal("restart"), id: z.uuid() }),
  z.strictObject({ command: z.literal("delete"), id: z.uuid() }),
  z.strictObject({ command: z.literal("claim"), id: z.uuid() }),
  z.strictObject({ command: z.literal("resume"), id: z.uuid() }),
]);
export const testnetSnapshotSchema = z.object({
  owner: z.object({
    id: z.string(),
    kind: z.enum(["guest", "wallet"]),
    accountId: z.string().nullable(),
    expiresAt: z.number(),
  }),
  balances: z.array(
    z.object({
      location: testnetLocationSchema,
      assetId: z.string(),
      units: tokenUnitsSchema,
      reserved: tokenUnitsSchema,
    }),
  ),
  orders: z.array(
    z.object({
      id: z.string(),
      createdAt: z.number(),
      bucket: z.string(),
      kind: z.string(),
      state: z.string(),
      assetId: z.string(),
      inputUnits: tokenUnitsSchema,
      location: testnetLocationSchema,
      outputLocation: testnetLocationSchema,
      outputAssetId: z.string().nullable(),
      outputUnits: tokenUnitsSchema.nullable(),
      quotedOutputUnits: tokenUnitsSchema.nullable(),
      minimumOutputUnits: tokenUnitsSchema.nullable(),
      maxNetworkUnits: tokenUnitsSchema,
      registrationUnits: tokenUnitsSchema,
      recipient: z.string(),
      expiresAt: z.number(),
      txHash: z.string().nullable(),
      message: z.string().nullable(),
      calls: z
        .array(
          z.object({
            receiverId: z.string(),
            method: z.string().nullable(),
            args: z.record(z.string(), z.unknown()),
            deposit: tokenUnitsSchema,
            gas: tokenUnitsSchema,
          }),
        )
        .optional(),
    }),
  ),
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      state: z.string(),
      reason: z.string().nullable(),
      rule: testnetRuleSchema,
      createdAt: z.number(),
      /** When its next order or price check is due (UTC ms). */
      nextAt: z.number(),
      /** What the agent's own balance holds now; `held` is reserved by unsettled orders. */
      holdings: z.array(
        z.object({
          assetId: z.string(),
          location: testnetLocationSchema,
          units: tokenUnitsSchema,
          held: tokenUnitsSchema,
        }),
      ),
      verification: testnetVerificationSchema.nullable(),
    }),
  ),
});
export type TestnetSnapshot = z.infer<typeof testnetSnapshotSchema>;
export function intentUnits(intent: TestnetIntent): bigint {
  return parseTokenAmount(intent.amount, testnetAsset(intent.assetId).decimals);
}
