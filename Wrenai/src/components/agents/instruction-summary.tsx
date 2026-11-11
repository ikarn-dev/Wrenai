import type { ReactElement } from "react";
import { Badge } from "@/components/ui/badge";
import { budgetTokenAmount } from "@/shared/agent-budget";
import {
  type AgentInstruction,
  instructionAssets,
  instructionFundingAsset,
  usesNativeNearPayout,
  usesPublicRoute,
} from "@/shared/agent-instructions";
import { shortTokenAmount } from "@/shared/money";
import type { TradeAsset } from "@/shared/trade-preview";
import { WALLET_SWAP_INPUT, WALLET_SWAP_NATIVE_OUTPUT, WALLET_SWAP_USDC } from "@/shared/wallet-swap";

function percentage(basisPoints: number): string {
  return `${Math.trunc(basisPoints / 100)}.${String(basisPoints % 100).padStart(2, "0")}%`;
}

// Agents hold NEAR in the private balance as 1Click's NEAR asset (wrap.near), funded from native NEAR, so both
// read as NEAR here. Well-known tokens keep readable amounts even when the registry couldn't be read.
const KNOWN: Readonly<Record<string, { readonly symbol: string; readonly decimals: number }>> = {
  [WALLET_SWAP_INPUT]: { symbol: "NEAR", decimals: 24 },
  [WALLET_SWAP_NATIVE_OUTPUT]: { symbol: "NEAR", decimals: 24 },
  [WALLET_SWAP_USDC]: { symbol: "USDC", decimals: 6 },
};

function tokenName(asset: TradeAsset): string {
  return KNOWN[asset.assetId]?.symbol ?? asset.tokenSymbol;
}

function idName(id: string): string {
  return KNOWN[id]?.symbol ?? id.replace(/^nep141:/, "");
}

function tokenAmount(units: string, token: TradeAsset | undefined, id: string | null): string {
  const known = id ? KNOWN[id] : undefined;
  if (token) {
    return `${shortTokenAmount(units, token.decimals)} ${tokenName(token)}`;
  }
  return known ? `${shortTokenAmount(units, known.decimals)} ${known.symbol}` : `${units} smallest units`;
}

function rows(
  instruction: AgentInstruction,
  assets: readonly TradeAsset[],
): readonly { readonly label: string; readonly value: string }[] {
  const fundingId = instructionFundingAsset(instruction);
  const funding = assets.find((asset) => asset.assetId === fundingId);
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
        : quoteId
          ? idName(quoteId)
          : "of the paired token"
      : "USD";
  const ids = instructionAssets(instruction);
  const items = [
    {
      label: "Tokens",
      value:
        ids
          .map((id) => {
            const asset = assets.find((candidate) => candidate.assetId === id);
            return asset ? tokenName(asset) : idName(id);
          })
          .join(" and ") || "Account watchlist",
    },
    {
      label: "Ends",
      value: `${new Date(instruction.expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC`,
    },
    // Stopping and keeping holdings is the default, so only the reviewed exception is worth a row.
    ...(instruction.onExpiry === "close" ? [{ label: "When it ends", value: "Sells what it holds" }] : []),
  ];
  if ("amountUnits" in instruction) {
    const amount =
      instruction.kind === "private_payments"
        ? "Payment amount"
        : instruction.kind === "dca"
          ? "Amount per purchase"
          : "Amount";
    items.push({ label: amount, value: tokenAmount(instruction.amountUnits, funding, fundingId) });
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
        { label: "Action", value: instruction.side === "buy" ? "Buy" : "Sell" },
        {
          label: "When",
          value:
            instruction.entry.type === "market"
              ? "Right away, at the current price"
              : `When the price is ${instruction.entry.direction} ${instruction.entry.price} ${unit}`,
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
        { label: "Quantity", value: tokenAmount(instruction.quantityUnits, funding, fundingId) },
        {
          label: "Total cost",
          value:
            instruction.priceUnit === "usd"
              ? `$${budgetTokenAmount(instruction.confirmedBasisUnits, 6)}`
              : tokenAmount(instruction.confirmedBasisUnits, quote, quoteId ?? null),
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
  // Only exits the user set are listed; an empty row per unset exit was noise.
  if ("exits" in instruction) {
    const { takeProfitPrice, stopLossPrice, trailingStopBps } = instruction.exits;
    if (takeProfitPrice) {
      items.push({ label: "Take profit at", value: `${takeProfitPrice} ${unit}` });
    }
    if (stopLossPrice) {
      items.push({ label: "Stop loss at", value: `${stopLossPrice} ${unit}` });
    }
    if (trailingStopBps !== null) {
      items.push({ label: "Trailing stop", value: percentage(trailingStopBps) });
    }
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
      {usesPublicRoute(instruction) ? (
        <div className="mb-3 flex flex-col items-start gap-1.5 rounded-sm bg-sunken p-3">
          <Badge tone="warn">Public route</Badge>
          <p className="text-small text-fg-muted">
            {usesNativeNearPayout(instruction)
              ? "Buys native NEAR with a public RHEA swap from your trading account. The swaps are visible on-chain."
              : "A token here has no private route, so this agent swaps on RHEA from your trading account. Its trades are visible on-chain."}
          </p>
        </div>
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
    </div>
  );
}
