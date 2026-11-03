import type { ReactElement } from "react";
import { type AgentInstruction, instructionAssets } from "@/shared/agent-instructions";

function rows(instruction: AgentInstruction): readonly { readonly label: string; readonly value: string }[] {
  const unit =
    "priceUnit" in instruction && instruction.priceUnit === "quote_token" ? "quote token units" : "USD";
  const items = [
    { label: "Price unit", value: unit },
    { label: "Exact tokens", value: instructionAssets(instruction).join(" / ") || "Account watchlist" },
    { label: "Expires (UTC)", value: instruction.expiresAt },
    {
      label: "At expiry",
      value:
        instruction.onExpiry === "close"
          ? "Close the owned position"
          : "Stop new actions; keep existing holdings",
    },
  ];
  if ("amountUnits" in instruction) {
    items.push({ label: "Amount · smallest token units", value: instruction.amountUnits });
  }
  switch (instruction.kind) {
    case "dca":
      items.push(
        {
          label: "Schedule",
          value:
            instruction.schedule.type === "interval"
              ? `Every ${instruction.schedule.intervalSeconds} seconds from ${instruction.schedule.startAt}`
              : `${instruction.schedule.hour.toString().padStart(2, "0")}:${instruction.schedule.minute.toString().padStart(2, "0")} · ${instruction.schedule.timezone} · days ${instruction.schedule.weekdays.join(", ")} (Sunday = 0)`,
        },
        { label: "Maximum purchases", value: String(instruction.maxRuns) },
        { label: "Missed purchases", value: "Skip" },
      );
      break;
    case "spot_trader":
      items.push(
        { label: "Action", value: instruction.side },
        {
          label: "Entry",
          value:
            instruction.entry.type === "market"
              ? "Current bounded quote"
              : `${instruction.entry.direction} ${instruction.entry.price} ${unit}`,
        },
      );
      break;
    case "private_payments":
      items.push(
        { label: "Recipient", value: instruction.recipient },
        {
          label: "Destination",
          value:
            instruction.destination === "near_wallet"
              ? "Public NEAR wallet · recipient and payout visible on-chain"
              : "Confidential balance",
        },
        { label: "Earliest payment", value: instruction.executeAfter },
      );
      break;
    case "perps":
      items.push(
        {
          label: "Market / action",
          value: `${instruction.market} · ${instruction.action} ${instruction.side}`,
        },
        { label: "Base quantity", value: instruction.quantity },
        {
          label: "Margin",
          value: `${instruction.marginMode} · ${instruction.leverage}× · maximum $${instruction.maximumMarginUsd}`,
        },
      );
      break;
    case "buy_the_dip":
      items.push(
        {
          label: "Dip rule",
          value:
            instruction.reference.type === "price"
              ? `At or below ${instruction.reference.price} ${unit}`
              : `${instruction.reference.drawdownBps} bps below observed ${instruction.reference.windowSeconds}-second high`,
        },
        { label: "Maximum entries", value: String(instruction.maxEntries) },
      );
      break;
    case "sell_the_top":
      items.push(
        { label: "Quantity · smallest token units", value: instruction.quantityUnits },
        { label: "Confirmed basis · reviewed unit", value: instruction.confirmedBasisUnits },
        {
          label: "Profit exits",
          value: instruction.targets
            .map((target) => `${target.sellBps} bps of inventory at ${target.profitBps} bps net profit`)
            .join("; "),
        },
      );
      break;
    case "meme_hunter":
      items.push(
        { label: "Listing age", value: `At most ${instruction.maximumAgeSeconds} seconds` },
        { label: "Minimum liquidity", value: `$${instruction.minimumLiquidityUsd}` },
        { label: "Maximum positions", value: String(instruction.maximumPositions) },
      );
      break;
    case "whale_tracker":
      items.push(
        { label: "Watched accounts", value: instruction.accounts.join(", ") },
        { label: "Events", value: instruction.events.join(", ") },
        {
          label: "Minimum movement",
          value:
            instruction.threshold.type === "usd"
              ? `$${instruction.threshold.amountUsd}`
              : `${instruction.threshold.amountUnits} smallest units · ${instruction.threshold.assetId}`,
        },
      );
      break;
    default: {
      const impossible: never = instruction;
      return impossible;
    }
  }
  if ("exits" in instruction) {
    items.push(
      {
        label: "Take profit",
        value: instruction.exits.takeProfitPrice ? `${instruction.exits.takeProfitPrice} ${unit}` : "None",
      },
      {
        label: "Protective stop",
        value: instruction.exits.stopLossPrice ? `${instruction.exits.stopLossPrice} ${unit}` : "None",
      },
      {
        label: "Trailing stop",
        value:
          instruction.exits.trailingStopBps === null ? "None" : `${instruction.exits.trailingStopBps} bps`,
      },
    );
  }
  return items;
}
export function InstructionSummary({
  instruction,
}: {
  readonly instruction: AgentInstruction;
}): ReactElement {
  return (
    <dl className="divide-y divide-line/60">
      {rows(instruction).map((item) => (
        <div key={item.label} className="flex items-start justify-between gap-4 py-2">
          <dt className="shrink-0 text-small text-fg-muted">{item.label}</dt>
          <dd className="min-w-0 break-words text-right text-small text-fg-strong">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
