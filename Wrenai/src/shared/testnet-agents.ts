import { z } from "zod";
import type { TestnetRule } from "./testnet";
export const testnetAgentToolSchema = z.enum([
  "private_payments",
  "spot_trader",
  "dca",
  "buy_the_dip",
  "sell_the_top",
]);
export const TESTNET_AGENT_KINDS = {
  private_payments: "payments",
  spot_trader: "spot",
  dca: "dca",
  buy_the_dip: "dip",
  sell_the_top: "profit",
} as const;
export function testnetAgentTool(kind: string): z.infer<typeof testnetAgentToolSchema> {
  return testnetAgentToolSchema.options.find((tool) => TESTNET_AGENT_KINDS[tool] === kind) ?? "spot_trader";
}
export function testnetRuleText(rule: TestnetRule): string {
  const token = (id: string): string =>
    id === "native:near" ? "NEAR" : (id.slice(7).split(".")[0]?.toUpperCase() ?? id);
  const action =
    rule.kind === "payments"
      ? `Send ${rule.amount} ${token(rule.assetId)} to ${rule.recipient}.`
      : `Spend ${rule.amount} ${token(rule.assetId)} for ${token(rule.outputAssetId ?? "")}.`;
  const condition =
    rule.kind === "dca"
      ? ` Every ${rule.intervalSeconds} seconds.`
      : rule.kind === "dip"
        ? ` After a ${rule.thresholdBps / 100}% dip from activation.`
        : rule.kind === "profit"
          ? ` When proceeds exceed ${rule.costBasis} ${token(rule.outputAssetId ?? "")} by ${rule.thresholdBps / 100}%.`
          : "";
  return `${action}${condition} Budget ${rule.budget} ${token(rule.assetId)}.`;
}
