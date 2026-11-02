import { z } from "zod";

/** The only selectable agent families. Historical schemas remain readable for receipts and recovery. */
export const activeAgentToolSchema = z.enum([
  "private_payments",
  "dca",
  "spot_trader",
  "perps",
  "meme_hunter",
  "whale_tracker",
  "buy_the_dip",
  "sell_the_top",
]);
export type ActiveAgentTool = z.infer<typeof activeAgentToolSchema>;
export function isActiveAgentTool(value: unknown): value is ActiveAgentTool {
  return activeAgentToolSchema.safeParse(value).success;
}
export const REMOVED_AGENT_MESSAGE =
  "This agent type has been removed. Choose Private Payments, DCA, Spot Trader, Perps, Meme Hunter, Whale Tracker, Buy the Dip or Sell the Top.";
export function isRemovedExecutablePack(pack: string): boolean {
  return pack === "rebalancer" || pack === "copy_trading";
}
