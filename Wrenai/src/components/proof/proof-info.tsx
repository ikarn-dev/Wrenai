"use client";

import { Info } from "lucide-react";
import { Tooltip } from "radix-ui";
import type { ReactElement } from "react";
import { useAppNetwork } from "@/components/shell/network-context";

const POINTS = [
  { label: "Strategies", text: "Verified by NEAR AI at review" },
  { label: "Trades", text: "Settled on NEAR, 1Click or Hyperliquid" },
  { label: "Signing", text: "Encrypted keys on Wrenai’s backend" },
] as const;

/** What the records prove. Opens on hover and keyboard focus, like the Agents info. */
export function ProofInfo(): ReactElement {
  const network = useAppNetwork();
  const points =
    network === "testnet"
      ? [
          { label: "Strategies", text: "NEAR AI review; saved evidence only where shown" },
          { label: "Trades", text: "Public NEAR Testnet and Tidepool receipts" },
          { label: "Signing", text: "App-managed guest funds or wallet approval" },
        ]
      : POINTS;
  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label="What these records show"
            className="inline-flex size-8 cursor-default items-center justify-center rounded-full text-fg-subtle transition-colors duration-200 ease-ios hover:text-fg-strong pointer-coarse:size-11"
          >
            <Info size={16} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className="z-50 card-shine rounded-md px-3 py-2.5 shadow-float"
          >
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-caption">
              {points.map((point) => (
                <div key={point.label} className="contents">
                  <dt className="text-fg-subtle">{point.label}</dt>
                  <dd className="text-fg">{point.text}</dd>
                </div>
              ))}
            </dl>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
