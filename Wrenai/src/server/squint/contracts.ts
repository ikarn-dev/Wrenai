import { z } from "zod";
import { compare, decimal } from "@/server/research/decimal";
import { nearAccountSchema } from "@/shared/agent-budget";
import { MEMECOIN_SORTS, type MemecoinSort } from "@/shared/market-pages";

const scalar = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => {
    try {
      return decimal(value).n >= 0n;
    } catch {
      return false;
    }
  }, "Invalid nonnegative market decimal.");
const share = scalar.refine((value) => compare(decimal(value), { n: 1n, d: 1n }) <= 0);
const count = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,15})$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().safe());
const label = z.string().max(160);
const time = z.iso.datetime({ offset: true }).nullable();
export const SQUINT_CHECKS = [
  "copy",
  "dev",
  "history",
  "snipers",
  "linked",
  "top10",
  "fresh",
  "tax",
  "liquidity",
] as const;
export const squintCheckSchema = z.object({
  id: z.string().min(1).max(40),
  label,
  status: z.enum(["good", "warn", "bad", "unknown"]),
  headline: z.string().max(600),
  detail: z.string().max(3000),
});
const verdict = z.enum(["clean", "caution", "danger"]).nullable();
export const squintCoinSchema = z.object({
  token: nearAccountSchema,
  symbol: label,
  name: label,
  created_at: time,
  holders: count,
  holders_capped: z.boolean(),
  liquidity_near: scalar.nullable(),
  fdv_usd: scalar.nullable(),
  verdict,
  risk: count.pipe(z.number().max(100)).nullable(),
  launchpad: z.string().min(1).max(50),
});
export const squintCoinsSchema = z
  .object({
    total: count,
    offset: count,
    count: count,
    sort: z.literal("age"),
    dir: z.literal("desc"),
    coins: z.array(squintCoinSchema).max(100),
  })
  .superRefine((value, ctx) => {
    if (
      value.count !== value.coins.length ||
      value.count > value.total ||
      new Set(value.coins.map((coin) => coin.token)).size !== value.coins.length
    ) {
      ctx.addIssue({ code: "custom", message: "Inconsistent listing pagination." });
    }
  });
export type SquintSort = MemecoinSort;
const signed = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => {
    try {
      decimal(value);
      return true;
    } catch {
      return false;
    }
  }, "Invalid market decimal.");
// The coin index for the Memecoins page: the listing fields plus market figures. Fields Meme Hunter never reads
// are optional, so a provider change there can't break its admission checks.
export const squintIndexCoinSchema = squintCoinSchema.extend({
  icon: z.string().max(600).nullable().optional(),
  volume_24h_usd: scalar.nullable().optional(),
  change_24h_pct: signed.nullable().optional(),
});
export const squintIndexSchema = z
  .object({
    total: count,
    sort: z.enum(MEMECOIN_SORTS),
    near_usd: scalar,
    coins: z.array(squintIndexCoinSchema).max(100),
  })
  .refine((value) => new Set(value.coins.map((coin) => coin.token)).size === value.coins.length, {
    message: "The coin index repeats a token.",
  });
export type SquintIndexCoin = z.infer<typeof squintIndexCoinSchema>;
export const squintReportSchema = z
  .object({
    token: nearAccountSchema,
    symbol: label,
    name: label,
    creator: nearAccountSchema.nullable(),
    created_at: time,
    checked_at: z.iso.datetime({ offset: true }),
    verdict,
    risk: count.pipe(z.number().max(100)).nullable(),
    launchpad: z.object({ id: z.string().min(1).max(50), name: label }),
    checks: z.array(squintCheckSchema).max(30),
    market: z.object({
      liquidity_near: scalar.nullable(),
      holders: count,
      holders_capped: z.boolean(),
      fdv_usd: scalar.nullable(),
    }),
    tax: z.object({
      status: z.enum(["none", "set", "unknown"]),
      buy_pct: scalar.nullable(),
      sell_pct: scalar.nullable(),
    }),
    holders: z
      .array(z.object({ account: nearAccountSchema, share, tags: z.array(z.string().max(40)).max(20) }))
      .max(100),
    clusters: z.array(z.object({ share, wallets: z.array(nearAccountSchema).max(200) })).max(100),
    coverage: z.object({ wallets_traced: count, wallets_checked: count, transfers_complete: z.boolean() }),
    supply: z.object({ pool: share, dev: share, snipers: share, linked: share, holders: share, rest: share }),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.checks.map((check) => check.id)).size !== value.checks.length ||
      new Set(value.holders.map((holder) => holder.account)).size !== value.holders.length ||
      value.coverage.wallets_traced > value.coverage.wallets_checked
    ) {
      ctx.addIssue({ code: "custom", message: "The risk report repeats or contradicts its coverage." });
    }
  });
export const squintSearchSchema = z.object({
  results: z.array(z.object({ token: nearAccountSchema, symbol: label, name: label })).max(25),
});
export type SquintReport = z.infer<typeof squintReportSchema>;
export type SquintCoin = z.infer<typeof squintCoinSchema>;
export type SquintCheck = z.infer<typeof squintCheckSchema>;

export class SquintUnavailable extends Error {
  constructor(
    readonly code: "unavailable" | "limited" | "pending" | "not_found" | "ambiguous",
    message: string,
  ) {
    super(message);
    this.name = "SquintUnavailable";
  }
}
