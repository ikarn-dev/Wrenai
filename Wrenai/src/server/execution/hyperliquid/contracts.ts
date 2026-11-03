import { z } from "zod";
export const HYPERLIQUID_BRIDGE_USDC = "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054";
export const hlAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
export const hlDecimalSchema = z
  .string()
  .max(80)
  .regex(/^(?:0|[1-9]\d{0,20})(?:\.\d{1,18})?$/);
export const hlSignedDecimalSchema = z
  .string()
  .max(81)
  .regex(/^-?(?:0|[1-9]\d{0,20})(?:\.\d{1,18})?$/);
export const cloidSchema = z.string().regex(/^0x[a-f0-9]{32}$/);
const trigger = z.strictObject({
  isMarket: z.boolean(),
  triggerPx: hlDecimalSchema,
  tpsl: z.enum(["tp", "sl"]),
});
export const hlOrderSchema = z.strictObject({
  a: z.number().int().min(0).max(1999),
  b: z.boolean(),
  p: hlDecimalSchema,
  s: hlDecimalSchema,
  r: z.boolean(),
  t: z.union([
    z.strictObject({ limit: z.strictObject({ tif: z.enum(["Ioc", "Gtc", "Alo"]) }) }),
    z.strictObject({ trigger }),
  ]),
  c: cloidSchema.optional(),
});
export const hlActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("order"),
    orders: z.array(hlOrderSchema).min(1).max(3),
    grouping: z.enum(["na", "normalTpsl", "positionTpsl"]),
  }),
  z.strictObject({
    type: z.literal("cancelByCloid"),
    cancels: z
      .array(z.strictObject({ asset: z.number().int().min(0).max(1999), cloid: cloidSchema }))
      .min(1)
      .max(3),
  }),
  z.strictObject({
    type: z.literal("updateLeverage"),
    asset: z.number().int().min(0).max(1999),
    isCross: z.literal(false),
    leverage: z.number().int().min(1).max(50),
  }),
]);
export type HlAction = z.infer<typeof hlActionSchema>;
export type HlOrder = z.infer<typeof hlOrderSchema>;
export function perpsCashAssetId(address: string): string {
  return `hyperliquid:usdc:${hlAddressSchema.parse(address).toLowerCase()}`;
}
export function perpsInstrumentId(address: string, market: string): string {
  return `${hlAddressSchema.parse(address).toLowerCase()}:${z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .parse(market)}`;
}
