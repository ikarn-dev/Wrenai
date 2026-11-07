// The flows Wrenai runs today, hub-and-spoke: what feeds a step on the left, the step itself in the middle, where
// it goes on the right. Every service named is the one the app actually calls (Docs/wrenai-spec.md, tech-stack.md),
// shown by its logo (`brand`). 1Click calls show as NEAR Intents, the product they belong to.

import type { BrandId } from "@/components/brands/brand-logo";

export type StepIcon =
  | "wallet"
  | "server"
  | "message"
  | "cpu"
  | "shield-check"
  | "pointer"
  | "shield"
  | "chart"
  | "waypoints";

export interface FlowSpoke {
  readonly id: string;
  readonly label: string;
  /** A third-party service, shown by its logo. Otherwise a Wrenai step with its icon. */
  readonly brand?: BrandId;
  readonly icon?: StepIcon;
  /** Striped: work that keeps running in the background until it's final (polling, settlement, streaming). */
  readonly striped?: true;
}

export interface Flow {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  /** Wide cards spread their spokes further. */
  readonly wide: boolean;
  readonly hub: { readonly label: string; readonly icon: StepIcon; readonly brand?: BrandId };
  readonly inputs: readonly FlowSpoke[];
  readonly outputs: readonly FlowSpoke[];
}

export const FLOWS: readonly Flow[] = [
  {
    id: "agents",
    title: "Agents stay inside your limits",
    text: "Every order passes the Guard first. If a check can’t run, nothing trades.",
    wide: true,
    hub: { label: "Guard", icon: "shield" },
    inputs: [
      // NEAR AI Cloud turns the plain-words strategy into reviewed rules.
      { id: "rules", label: "NEAR AI Cloud", brand: "near-ai" },
      // The deposit is one approval in the wallet connected through HOT Labs' NEAR Connect.
      { id: "deposit", label: "HOT Labs", brand: "hot" },
      // The workflow keeps reading prices and the schedule between checks.
      { id: "market", label: "Market data", icon: "chart", striped: true },
    ],
    outputs: [
      { id: "intents", label: "NEAR Intents", brand: "near-intents", striped: true },
      { id: "rhea", label: "RHEA Finance", brand: "rhea", striped: true },
      { id: "perps", label: "Hyperliquid", brand: "hyperliquid", striped: true },
    ],
  },
  {
    id: "jarvis",
    title: "Research you can verify",
    text: "Answers come from a model in a secure enclave. Each reply’s signature is checked.",
    wide: false,
    hub: { label: "NEAR AI Cloud", icon: "cpu", brand: "near-ai" },
    inputs: [
      { id: "question", label: "Your question", icon: "message" },
      { id: "squint", label: "Squint", brand: "squint", striped: true },
    ],
    outputs: [
      { id: "verified", label: "Verified reply", icon: "shield-check", striped: true },
      { id: "quote", label: "NEAR Intents", brand: "near-intents" },
    ],
  },
  {
    id: "trading",
    title: "Every trade on one card",
    text: "Exact amounts, fees and expiry. Nothing moves until you confirm.",
    wide: false,
    hub: { label: "You confirm", icon: "pointer" },
    inputs: [
      { id: "wallet", label: "HOT Labs", brand: "hot" },
      { id: "balance", label: "Funded balance", icon: "server" },
    ],
    outputs: [
      { id: "oneclick", label: "NEAR Intents", brand: "near-intents", striped: true },
      { id: "rhea", label: "RHEA Finance", brand: "rhea", striped: true },
      { id: "perps", label: "Hyperliquid", brand: "hyperliquid", striped: true },
    ],
  },
  {
    id: "funds",
    title: "Your funds come back",
    text: "Fund an agent in one transfer. Deleting it returns everything it holds.",
    wide: true,
    hub: { label: "Agent", icon: "waypoints" },
    inputs: [{ id: "deposit", label: "HOT Labs", brand: "hot" }],
    outputs: [
      { id: "private", label: "NEAR Intents", brand: "near-intents" },
      { id: "returned", label: "Your wallet", icon: "wallet", striped: true },
    ],
  },
];

// Flow coordinates. The hub is centered on 0, 0; inputs end and outputs start a fixed distance from it, so every
// line has the same reach whatever a chip's width. The diagram scales to fit its card.
const ROW_GAP = 56;

/** Where a spoke's inner edge sits: inputs right-aligned to the left of the hub, outputs left-aligned to its right. */
export function spokeAnchor(
  flow: Flow,
  side: "input" | "output",
  index: number,
): { readonly x: number; readonly y: number } {
  const count = side === "input" ? flow.inputs.length : flow.outputs.length;
  const reach = flow.wide ? 170 : 128;
  return { x: side === "input" ? -reach : reach, y: (index - (count - 1) / 2) * ROW_GAP };
}
