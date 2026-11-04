import "server-only";
import { z } from "zod";
import { callViewFunction, viewNearBalance } from "@/server/near/rpc";
import type { ResearchInput, ResearchItem, ResearchSource } from "@/shared/research";
import { displayDecimal } from "./decimal";
import { publicLeaderResearch } from "./explorer-research";
import { publicFills } from "./hyperliquid";
import { intentTokens, selectToken } from "./intents";

const nearAccount = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

export async function leaderResearch(
  input: ResearchInput,
  signal?: AbortSignal,
): Promise<{
  readonly items: readonly ResearchItem[];
  readonly sources: readonly ResearchSource[];
  readonly summary: string;
}> {
  if (!input.accountId) {
    return {
      items: [],
      sources: [],
      summary:
        "A public NEAR leader account or Hyperliquid address is required to inspect actual activity. Ask for the account rather than invent a leaderboard.",
    };
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(input.accountId)) {
    const result = await publicFills(input.accountId, signal);
    return {
      items: result.items,
      sources: [result.source],
      summary: `Retrieved ${result.items.length} recent public Hyperliquid fills. This does not establish total PnL or copy-trade execution.`,
    };
  }
  const account = nearAccount.parse(input.accountId);
  const source: ResearchSource = {
    id: "near-leader",
    label: "Public NEAR account",
    url: `https://nearblocks.io/address/${account}`,
    observedAt: Date.now(),
  };
  const [balance, history] = await Promise.allSettled([
    viewNearBalance(account, signal),
    publicLeaderResearch(account),
  ]);
  const items: ResearchItem[] = [];
  if (balance.status === "fulfilled") {
    items.push({
      id: `near-account:${account}`,
      title: account,
      kind: "account",
      status: "observed",
      metrics: [
        {
          label: "Native balance",
          value:
            balance.value === null
              ? "Account does not exist"
              : `${displayDecimal({ n: balance.value, d: 10n ** 24n }, 8)} NEAR`,
        },
      ],
      note: "Public native balance only; it is not portfolio PnL or evidence of profitable trades.",
      sourceIds: [source.id],
    });
  }
  if (history.status === "fulfilled") {
    items.push(...history.value.items);
  }
  return {
    items,
    sources: [source, ...(history.status === "fulfilled" ? [history.value.source] : [])],
    summary:
      history.status === "fulfilled"
        ? `Found ${history.value.items.length} confirmed matching public swaps in the bounded NEAR-origin 1Click feed. Whole-wallet history and total PnL are unknown. Copy Trading requires a separate reviewed and activated agent.`
        : "The confirmed public swap feed is unavailable. Native account balance alone cannot establish leader trading history or performance.",
  };
}

export async function paymentResearch(
  input: ResearchInput,
  signal?: AbortSignal,
): Promise<{
  readonly items: readonly ResearchItem[];
  readonly sources: readonly ResearchSource[];
  readonly summary: string;
}> {
  if (!input.accountId) {
    return {
      items: [],
      sources: [],
      summary:
        "Ask for the recipient's public NEAR account and asset/amount before preparing a payment setup draft. No funds can be sent from chat.",
    };
  }
  const account = nearAccount.parse(input.accountId);
  const registry = await intentTokens(signal);
  const token = selectToken(registry.tokens, input.symbols[0] ?? "NEAR");
  const balance = await viewNearBalance(account, signal);
  const metrics = [
    {
      label: "Recipient account",
      value: balance === null ? "Does not exist on mainnet" : "Exists on mainnet",
    },
    {
      label: "Requested amount",
      value: input.amount
        ? `${input.amount} ${input.amountAsset ?? token?.symbol ?? input.symbols[0] ?? "NEAR"}`
        : "Not specified",
    },
  ];
  if (
    token?.blockchain === "near" &&
    token.contractAddress &&
    nearAccount.safeParse(token.contractAddress).success
  ) {
    const storage = await callViewFunction(token.contractAddress, "storage_balance_of", {
      account_id: account,
    });
    metrics.push({
      label: "Token storage registration",
      value:
        z
          .object({ total: z.string().regex(/^\d+$/), available: z.string().regex(/^\d+$/) })
          .nullable()
          .parse(storage.value) === null
          ? "Not registered"
          : "Registration exists",
    });
  }
  const source: ResearchSource = {
    id: "payment-recipient",
    label: "Public NEAR recipient/storage views",
    url: `https://nearblocks.io/address/${account}`,
    observedAt: Date.now(),
  };
  return {
    items: [
      {
        id: `recipient:${account}`,
        title: `Payment setup for ${account}`,
        kind: "account",
        status: "observed",
        metrics,
        note: "Account existence/storage are public checks. A confidential transfer route, authorization and final fee are not established; chat cannot send funds.",
        sourceIds: [source.id],
      },
    ],
    sources: [registry.source, source],
    summary:
      "Recipient and available token registration checks are complete. This is payment research/setup information, not a transfer or authorization.",
  };
}
