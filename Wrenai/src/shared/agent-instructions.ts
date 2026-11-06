import { z } from "zod";
import { nearAccountSchema } from "./agent-budget";
import { WALLET_SWAP_NATIVE_OUTPUT, WALLET_SWAP_USDC } from "./swap-assets";
import { positiveTokenUnitsSchema } from "./token-units";

export const instructionAssetSchema = z
  .string()
  .min(3)
  .max(180)
  .regex(/^nep141:[a-z0-9._-]+$/);
const amount = positiveTokenUnitsSchema;
const decimal = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,36})?$/)
  .refine((v) => /[1-9]/.test(v), "A positive decimal is required.");
const bps = z.number().int().min(1).max(9999);
const expiresAt = z.iso.datetime();
const common = { format: z.literal(2), expiresAt, onExpiry: z.enum(["stop", "close"]).default("stop") };
const spotAsset = z.union([instructionAssetSchema, z.literal(WALLET_SWAP_NATIVE_OUTPUT)]);
const pair = {
  payAssetId: spotAsset,
  buyAssetId: spotAsset,
  priceUnit: z.enum(["usd", "quote_token"]),
};
const exits = z.strictObject({
  takeProfitPrice: decimal.nullable(),
  stopLossPrice: decimal.nullable(),
  trailingStopBps: bps.nullable(),
});
const entry = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("market") }),
  z.strictObject({ type: z.literal("price"), direction: z.enum(["above", "below"]), price: decimal }),
]);
export const dcaScheduleSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("interval"),
    startAt: z.iso.datetime(),
    intervalSeconds: z.number().int().min(60).max(2_592_000),
  }),
  z.strictObject({
    type: z.literal("calendar"),
    timezone: z
      .string()
      .min(1)
      .max(80)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, "Choose a valid timezone."),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length),
  }),
]);
const spot = z.strictObject({
  ...common,
  ...pair,
  kind: z.literal("spot_trader"),
  amountUnits: amount,
  side: z.enum(["buy", "sell"]),
  entry,
  exits,
});
const dca = z.strictObject({
  ...common,
  ...pair,
  kind: z.literal("dca"),
  amountUnits: amount,
  schedule: dcaScheduleSchema,
  maxRuns: z.number().int().min(1).max(100_000),
  missedSlots: z.literal("skip"),
});
const dip = z.strictObject({
  ...common,
  ...pair,
  kind: z.literal("buy_the_dip"),
  amountUnits: amount,
  reference: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("price"), price: decimal }),
    z.strictObject({
      type: z.literal("rolling_high"),
      windowSeconds: z.number().int().min(60).max(86400),
      drawdownBps: bps,
    }),
  ]),
  confirmationSeconds: z.number().int().min(0).max(300),
  cooldownSeconds: z.number().int().min(5).max(604800),
  maxEntries: z.number().int().min(1).max(1000),
  exits,
});
const top = z.strictObject({
  ...common,
  kind: z.literal("sell_the_top"),
  sellAssetId: instructionAssetSchema,
  receiveAssetId: spotAsset,
  priceUnit: z.enum(["usd", "quote_token"]),
  quantityUnits: amount,
  confirmedBasisUnits: amount,
  targets: z
    .array(
      z.strictObject({
        profitBps: z.number().int().min(1).max(1_000_000),
        sellBps: z.number().int().min(1).max(10000),
      }),
    )
    .min(1)
    .max(10),
  stopLossBps: bps.nullable(),
  trailingStopBps: bps.nullable(),
});
const payment = z.strictObject({
  ...common,
  kind: z.literal("private_payments"),
  assetId: instructionAssetSchema,
  amountUnits: amount,
  recipient: nearAccountSchema,
  destination: z.enum(["confidential", "near_wallet"]).default("confidential"),
  executeAfter: z.iso.datetime(),
});
// Historical records only; all creation, research and execution entry points reject this kind.
const whale = z.strictObject({
  ...common,
  kind: z.literal("whale_tracker"),
  accounts: z.array(nearAccountSchema).min(1).max(20),
  assetIds: z.array(instructionAssetSchema).max(6),
  threshold: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("token"),
      assetId: z.union([instructionAssetSchema, z.literal("native:near")]),
      amountUnits: amount,
    }),
    z.strictObject({ type: z.literal("usd"), amountUsd: decimal }),
  ]),
  cooldownSeconds: z.number().int().min(60).max(86400),
  events: z
    .array(z.enum(["native_transfer", "token_transfer"]))
    .min(1)
    .max(2),
});
const meme = z.strictObject({
  ...common,
  kind: z.literal("meme_hunter"),
  payAssetId: instructionAssetSchema,
  amountUnits: amount,
  maximumAgeSeconds: z.number().int().min(60).max(604800),
  minimumLiquidityUsd: decimal,
  maximumHolderBps: bps,
  maximumPriceImpactBps: z.number().int().min(1).max(500),
  priceUnit: z.enum(["usd", "quote_token"]),
  maximumPositions: z.number().int().min(1).max(20),
  exits,
});
const perps = z.strictObject({
  ...common,
  kind: z.literal("perps"),
  market: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9:_-]+$/),
  collateralAssetId: instructionAssetSchema,
  action: z.enum(["open", "reduce", "close"]),
  side: z.enum(["long", "short"]),
  quantity: z
    .string()
    .regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,18})?$/)
    .refine((v) => /[1-9]/.test(v)),
  leverage: z.number().int().min(1).max(50),
  marginMode: z.literal("isolated"),
  maximumMarginUsd: decimal,
  entry,
  exits,
});
const fields = z.discriminatedUnion("kind", [payment, dca, spot, perps, meme, whale, dip, top]);
export const agentInstructionSchema = fields.superRefine((instruction, context) => {
  if (instructionAssets(instruction).includes(WALLET_SWAP_NATIVE_OUTPUT)) {
    const [funding, output] =
      instruction.kind === "sell_the_top"
        ? [instruction.sellAssetId, instruction.receiveAssetId]
        : "buyAssetId" in instruction
          ? instruction.kind === "spot_trader" && instruction.side === "sell"
            ? [instruction.buyAssetId, instruction.payAssetId]
            : [instruction.payAssetId, instruction.buyAssetId]
          : [];
    if (!isNativeNearPayoutPair(funding, output)) {
      context.addIssue({ code: "custom", message: "The public native NEAR route supports USDC to NEAR." });
    } else if (
      "exits" in instruction &&
      (instruction.onExpiry === "close" || Object.values(instruction.exits).some((exit) => exit !== null))
    ) {
      context.addIssue({
        code: "custom",
        message: "This route buys native NEAR. Remove exit rules that would sell it back automatically.",
      });
    }
    if (
      (instruction.kind === "sell_the_top" ||
        (instruction.kind === "spot_trader" &&
          instruction.side === "sell" &&
          instruction.entry.type === "price")) &&
      instruction.priceUnit === "usd"
    ) {
      context.addIssue({ code: "custom", message: "Measure this USDC sale's price or cost in NEAR." });
    }
  }
  if (
    (instruction.kind === "dca" ||
      instruction.kind === "private_payments" ||
      instruction.kind === "whale_tracker") &&
    instruction.onExpiry === "close"
  ) {
    context.addIssue({
      code: "custom",
      message: "This instruction stops at expiry and does not authorize an unrelated sale.",
    });
  }
  if (
    instruction.kind === "spot_trader" &&
    instruction.side === "sell" &&
    Object.values(instruction.exits).some((value) => value !== null)
  ) {
    context.addIssue({
      code: "custom",
      message: "A spot sell closes owned inventory; attach protective exits to a buy instruction instead.",
    });
  }
  if (
    "payAssetId" in instruction &&
    "buyAssetId" in instruction &&
    instruction.payAssetId === instruction.buyAssetId
  ) {
    context.addIssue({ code: "custom", message: "Choose different input and output assets." });
  }
  if (
    instruction.kind === "sell_the_top" &&
    (instruction.sellAssetId === instruction.receiveAssetId ||
      instruction.targets.reduce((sum, target) => sum + target.sellBps, 0) > 10000 ||
      instruction.targets.some(
        (target, index) => index > 0 && target.profitBps <= (instruction.targets[index - 1]?.profitBps ?? 0),
      ))
  ) {
    context.addIssue({
      code: "custom",
      message: "Profit targets must increase and sell at most 100% of owned inventory.",
    });
  }
  if (
    instruction.kind === "private_payments" &&
    Date.parse(instruction.executeAfter) >= Date.parse(instruction.expiresAt)
  ) {
    context.addIssue({ code: "custom", message: "Payment timing must be before expiry." });
  }
  if (
    instruction.kind === "dca" &&
    instruction.schedule.type === "interval" &&
    Date.parse(instruction.schedule.startAt) >= Date.parse(instruction.expiresAt)
  ) {
    context.addIssue({ code: "custom", message: "DCA must start before expiry." });
  }
  if (
    instruction.kind === "perps" &&
    instruction.action === "open" &&
    instruction.exits.stopLossPrice === null
  ) {
    context.addIssue({
      code: "custom",
      message: "Opening a perpetual position requires a protective stop.",
    });
  }
  if (
    instruction.kind === "whale_tracker" &&
    (new Set(instruction.accounts).size !== instruction.accounts.length ||
      new Set(instruction.events).size !== instruction.events.length ||
      new Set(instruction.assetIds).size !== instruction.assetIds.length)
  ) {
    context.addIssue({ code: "custom", message: "Watchlists cannot repeat accounts, events or assets." });
  }
});
export type AgentInstruction = z.infer<typeof agentInstructionSchema>;

export function instructionAssets(instruction: AgentInstruction): readonly string[] {
  switch (instruction.kind) {
    case "spot_trader":
    case "dca":
    case "buy_the_dip":
      return [instruction.payAssetId, instruction.buyAssetId];
    case "sell_the_top":
      return [instruction.sellAssetId, instruction.receiveAssetId];
    case "private_payments":
      return [instruction.assetId];
    case "perps":
      return [instruction.collateralAssetId];
    case "meme_hunter":
      return [instruction.payAssetId];
    case "whale_tracker":
      return instruction.assetIds;
    default: {
      const impossible: never = instruction;
      return impossible;
    }
  }
}
export function instructionFundingAsset(instruction: AgentInstruction): string | null {
  if (instruction.kind === "spot_trader" && instruction.side === "sell") {
    return instruction.buyAssetId;
  }
  if ("payAssetId" in instruction) {
    return instruction.payAssetId;
  }
  if (instruction.kind === "private_payments") {
    return instruction.assetId;
  }
  if (instruction.kind === "perps") {
    return instruction.collateralAssetId;
  }
  if (instruction.kind === "sell_the_top") {
    return instruction.sellAssetId;
  }
  return null;
}

export function isNativeNearPayoutPair(input: string | undefined, output: string | undefined): boolean {
  return input === WALLET_SWAP_USDC && output === WALLET_SWAP_NATIVE_OUTPUT;
}

export function usesNativeNearPayout(instruction: AgentInstruction): boolean {
  return (
    instructionFundingAsset(instruction) === WALLET_SWAP_USDC &&
    instructionAssets(instruction).includes(WALLET_SWAP_NATIVE_OUTPUT)
  );
}
