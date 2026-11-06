import type { ReactElement } from "react";
import { budgetTokenAmount } from "@/shared/agent-budget";
import {
  type AgentInstruction,
  instructionAssets,
  instructionFundingAsset,
  usesNativeNearPayout,
} from "@/shared/agent-instructions";
import type { TradeAsset } from "@/shared/trade-preview";
import { WALLET_SWAP_INPUT, WALLET_SWAP_NATIVE_OUTPUT } from "@/shared/wallet-swap";

function percentage(basisPoints: number): string {
  return `${Math.trunc(basisPoints / 100)}.${String(basisPoints % 100).padStart(2, "0")}%`;
}

function tokenName(asset: TradeAsset): string {
  return asset.assetId === WALLET_SWAP_INPUT ? "wNEAR" : asset.tokenSymbol;
}

function tokenAmount(units: string, token: TradeAsset | undefined): string {
  return token
    ? `${budgetTokenAmount(units, token.decimals)} ${tokenName(token)}`
    : `${units} smallest units`;
}

function rows(
  instruction: AgentInstruction,
  assets: readonly TradeAsset[],
): readonly { readonly label: string; readonly value: string }[] {
  const funding = assets.find((asset) => asset.assetId === instructionFundingAsset(instruction));
  const quoteId =
    instruction.kind === "sell_the_top"
      ? instruction.receiveAssetId
      : "buyAssetId" in instruction
        ? instruction.payAssetId
        : undefined;
  const quote = assets.find((asset) => asset.assetId === quoteId);
  const unit =
    "priceUnit" in instruction && instruction.priceUnit === "quote_token"
      ? quote
        ? tokenName(quote)
        : "in the pair’s quote token"
      : "USD";
  const ids = instructionAssets(instruction);
  const items = [
    {
      label: "Tokens",
      value:
        ids
          .map((id) => {
            const asset = assets.find((candidate) => candidate.assetId === id);
            return asset
              ? tokenName(asset)
              : id === WALLET_SWAP_NATIVE_OUTPUT
                ? "NEAR"
                : id === WALLET_SWAP_INPUT
                  ? "wNEAR"
                  : id.replace(/^nep141:/, "");
          })
          .join(" / ") || "Account watchlist",
    },
    {
      label: "Expires (UTC)",
      value: new Date(instruction.expiresAt).toISOString().slice(0, 16).replace("T", " "),
    },
    {
      label: "At expiry",
      value: instruction.onExpiry === "close" ? "Close the owned position" : "Stop and keep holdings",
    },
  ];
  if ("priceUnit" in instruction && instruction.kind !== "dca") {
    items.unshift({ label: "Price unit", value: unit });
  }
  if ("amountUnits" in instruction) {
    const amount =
      instruction.kind === "private_payments"
        ? "Payment amount"
        : instruction.kind === "dca"
          ? "Amount per purchase"
          : "Amount";
    items.push({ label: amount, value: tokenAmount(instruction.amountUnits, funding) });
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
        { label: "Quantity", value: tokenAmount(instruction.quantityUnits, funding) },
        {
          label: "Total cost",
          value:
            instruction.priceUnit === "usd"
              ? `$${budgetTokenAmount(instruction.confirmedBasisUnits, 6)}`
              : tokenAmount(instruction.confirmedBasisUnits, quote),
        },
        {
          label: "Profit exits",
          value: instruction.targets
            .map(
              (target) => `Sell ${percentage(target.sellBps)} at ${percentage(target.profitBps)} net profit`,
            )
            .join(" · "),
        },
      );
      break;
    case "meme_hunter":
      items.push(
        { label: "Listing age", value: `At most ${instruction.maximumAgeSeconds} seconds` },
        { label: "Minimum liquidity", value: `$${instruction.minimumLiquidityUsd}` },
        { label: "Maximum positions", value: String(instruction.maximumPositions) },
        { label: "Holder / linked-group limit", value: percentage(instruction.maximumHolderBps) },
        { label: "Entry/exit quote loss limit", value: percentage(instruction.maximumPriceImpactBps) },
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
          instruction.exits.trailingStopBps === null ? "None" : percentage(instruction.exits.trailingStopBps),
      },
    );
  }
  return items;
}
export function InstructionSummary({
  instruction,
  assets,
}: {
  readonly instruction: AgentInstruction;
  readonly assets: readonly TradeAsset[];
}): ReactElement {
  return (
    <div>
      {usesNativeNearPayout(instruction) ? (
        <p className="mb-2 text-small text-fg-muted">
          Public RHEA swap. Native NEAR is paid into your backed-up trading account.
        </p>
      ) : null}
      <dl className="divide-y divide-line/60">
        {rows(instruction, assets).map((item) => (
          <div key={item.label} className="flex items-start justify-between gap-4 py-2">
            <dt className="shrink-0 text-small text-fg-muted">{item.label}</dt>
            <dd className="min-w-0 break-words text-right text-small text-fg-strong tabular-nums">
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
      {assets.some((asset) => asset.contractAddress !== null) ? (
        <details className="mt-2 text-caption text-fg-muted">
          <summary className="cursor-pointer">Token contracts</summary>
          <ul className="mt-2 space-y-1">
            {assets
              .filter((asset) => asset.contractAddress !== null)
              .map((asset) => (
                <li key={asset.assetId} className="break-all">
                  {tokenName(asset)} · {asset.contractAddress}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
