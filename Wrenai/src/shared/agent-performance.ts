import { z } from "zod";
import { tokenUnitsSchema } from "./token-units";

const signedUnits = z.string().regex(/^-?(?:0|[1-9]\d{0,77})$/);

/**
 * An agent's result so far, for its page. Mainnet measures it in USD from the attributed lots (the same figures as
 * Claims); testnet measures it in the agent's spend token from its filled orders at the current Tidepool quote.
 * Every figure is null when it can't be measured, never zero; `note` says why.
 */
export const agentPerformanceSchema = z.strictObject({
  unit: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("usd") }),
    z.strictObject({
      kind: z.literal("token"),
      symbol: z.string().min(1).max(64),
      decimals: z.number().int().min(0).max(36),
    }),
  ]),
  /** USD principal still held (mainnet) or spend-token units paid into filled orders (testnet). */
  invested: tokenUnitsSchema.nullable(),
  /** What that is worth now: reference prices (mainnet) or a dry Tidepool quote back to the spend token. */
  value: tokenUnitsSchema.nullable(),
  pnl: signedUnits.nullable(),
  /** Where `value` comes from, for the caption. */
  source: z.enum(["reference_prices", "tidepool_quote"]),
  observedAt: z.number().int().positive(),
  note: z.string().max(200).nullable(),
});
export type AgentPerformance = z.infer<typeof agentPerformanceSchema>;

/** Every testnet agent's PnL for the Portfolio page, in micro-USD from Tidepool's quote valuations. */
export const testnetPortfolioSchema = z.strictObject({
  agents: z
    .array(
      z.strictObject({
        agentId: z.string(),
        pnlMicroUsd: signedUnits.nullable(),
        basisMicroUsd: tokenUnitsSchema.nullable(),
        /** Has settled orders, so a missing PnL means "no quote right now" rather than "nothing to measure". */
        filled: z.boolean(),
      }),
    )
    .max(50),
  totalMicroUsd: signedUnits.nullable(),
  measuredCount: z.number().int().nonnegative(),
  observedAt: z.number().int().positive(),
});
export type TestnetPortfolio = z.infer<typeof testnetPortfolioSchema>;
