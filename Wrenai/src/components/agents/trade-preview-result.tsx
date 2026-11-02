"use client";
import { type ReactElement, useEffect, useState } from "react";
import { formatExactMicroUsd, formatUnits } from "@/shared/money";
import type { TradeAsset, TradePreview } from "@/shared/trade-preview";

function amount(units: string, asset: TradeAsset): string {
  return `${formatUnits(BigInt(units), { decimals: asset.decimals, fractionDigits: asset.decimals })
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "")} ${asset.tokenSymbol}`;
}
export function TradePreviewResult({ preview }: { readonly preview: TradePreview }): ReactElement {
  const [expired, setExpired] = useState(Date.now() >= preview.expiresAt);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), Math.max(0, preview.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [preview.expiresAt]);
  const quote = preview.quote;
  return (
    <div className="space-y-5 border-t border-line-subtle pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-body font-medium">
          {expired
            ? "Preview expired"
            : preview.decision === "allowed"
              ? "Checks passed"
              : preview.decision === "approval_required"
                ? "Approval required"
                : preview.purpose === "funding"
                  ? "Funding needs attention"
                  : "Trade blocked"}
        </h3>
        <span className="text-caption text-fg-subtle">
          {new Date(preview.createdAt).toISOString().slice(11, 19)} UTC
        </span>
      </div>
      {quote ? (
        <dl className="grid gap-3 text-small">
          {[
            ["Pay", amount(quote.inputUnits, preview.input)],
            ["Quoted receive", amount(quote.outputUnits, preview.output)],
            ["Minimum receive", amount(quote.minOutputUnits, preview.output)],
            [
              "USD debit estimate",
              quote.inputMicroUsd === null ? "Unavailable" : formatExactMicroUsd(BigInt(quote.inputMicroUsd)),
            ],
            ["Maximum slippage", `${quote.slippageBps} bps`],
            ["Partner fee", `${quote.appFeeBps} bps`],
          ]
            .filter(
              ([label]) =>
                preview.purpose !== "funding" || (label !== "Quoted receive" && label !== "Minimum receive"),
            )
            .map(([label, value]) => (
              <div key={label} className="grid min-w-0 gap-1 sm:grid-cols-2 sm:gap-4">
                <dt className="text-fg-subtle">
                  {label === "Pay" && preview.purpose === "funding" ? "Allocate from private balance" : label}
                </dt>
                <dd className="wrap-anywhere font-mono tabular-nums sm:text-right">{value}</dd>
              </div>
            ))}
        </dl>
      ) : (
        <p className="text-small text-warn">A fresh verified quote is unavailable.</p>
      )}
      <ul className="space-y-3">
        {preview.checks.map((check) => (
          <li key={check.id} className="flex items-start gap-3 text-small">
            <span className={`shrink-0 ${check.status === "passed" ? "text-accent-text" : "text-warn"}`}>
              {check.status === "passed"
                ? "Passed"
                : check.status === "approval_required"
                  ? "Review"
                  : "Blocked"}
            </span>
            <span className="min-w-0 text-fg-muted">{check.reason}</span>
          </li>
        ))}
      </ul>
      <details className="text-caption text-fg-subtle">
        <summary className="min-h-10 cursor-pointer rounded-sm py-2">Quote and balance details</summary>
        <p className="mt-2 leading-relaxed">{quote?.feeNote}</p>
        <p className="mt-3 leading-relaxed">{preview.balance.note}</p>
        <dl className="mt-3 space-y-2">
          <div>
            <dt>Input asset</dt>
            <dd className="wrap-anywhere font-mono">{preview.input.assetId}</dd>
          </div>
          <div>
            <dt>Output asset</dt>
            <dd className="wrap-anywhere font-mono">{preview.output.assetId}</dd>
          </div>
          <div>
            <dt>Evidence hash</dt>
            <dd className="wrap-anywhere font-mono">{preview.evidenceHash}</dd>
          </div>
        </dl>
      </details>
      <p className="text-caption text-fg-subtle">
        {expired
          ? "Request a fresh preview to check current conditions."
          : "This preview saves the checks and does not place an order."}
      </p>
    </div>
  );
}
