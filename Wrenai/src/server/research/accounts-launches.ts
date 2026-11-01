import "server-only";
import { z } from "zod";
import { callViewFunction, viewNearBalance } from "@/server/near/rpc";
import type { ResearchInput, ResearchItem, ResearchSource } from "@/shared/research";
import { displayDecimal } from "./decimal";
import { publicFills } from "./hyperliquid";
import { intentTokens, selectToken } from "./intents";
import { marketJson } from "./market-http";
import { poolItems, rheaPools } from "./rhea";

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
    label: "Public NEAR account and indexed transactions",
    url: `https://nearblocks.io/address/${account}`,
    observedAt: Date.now(),
  };
  const [balance, history] = await Promise.allSettled([
    viewNearBalance(account, signal),
    marketJson(
      "NEAR public transaction index",
      `https://api.nearblocks.io/v1/account/${encodeURIComponent(account)}/txns?order=desc&page=1&per_page=5`,
      { ...(signal ? { signal } : {}) },
    ),
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
    const parsed = z
      .object({
        txns: z
          .array(
            z.object({
              transaction_hash: z.string().max(100),
              receiver_account_id: z.string().max(64),
              block_timestamp: z.string().regex(/^\d{1,20}$/),
            }),
          )
          .max(100),
      })
      .safeParse(history.value.value);
    if (parsed.success) {
      for (const tx of parsed.data.txns.slice(0, 5)) {
        items.push({
          id: tx.transaction_hash,
          title: `Transaction to ${tx.receiver_account_id}`,
          kind: "account",
          status: "observed",
          metrics: [
            { label: "Transaction", value: tx.transaction_hash },
            {
              label: "Chain time",
              value: new Date(Number(BigInt(tx.block_timestamp) / 1_000_000n)).toISOString(),
            },
          ],
          note: "An indexed transaction is not a decoded swap or confirmed trading signal; no opaque transaction is copied.",
          sourceIds: [source.id],
        });
      }
    }
  }
  return {
    items,
    sources: [source],
    summary:
      items.length > 1
        ? "Public account and recent transaction records retrieved; no profitability or copyability is inferred."
        : "Public account state retrieved; a usable transaction feed was not available, so leader trade history and performance are unknown.",
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

export async function memeResearch(
  input: ResearchInput,
  signal?: AbortSignal,
): Promise<{
  readonly items: readonly ResearchItem[];
  readonly sources: readonly ResearchSource[];
  readonly summary: string;
}> {
  const pools = await rheaPools(signal);
  const launchPools = pools.pools
    .filter((pool) => pool.token_account_ids.some((id) => id.endsWith(".meme-cooking.near")))
    .sort((a, b) => Number(b.id) - Number(a.id));
  const selected = input.symbols.length
    ? launchPools.filter(
        (pool) =>
          pool.token_account_ids.some((id) => input.symbols.includes(id)) ||
          pool.token_symbols?.some((symbol) =>
            input.symbols.some((value) => value.toUpperCase() === symbol.toUpperCase()),
          ),
      )
    : launchPools;
  const finalizable = await Promise.allSettled([
    callViewFunction("meme-cooking.near", "get_finalizable_memes", { skip: 0, limit: 5 }, signal),
  ]);
  const source: ResearchSource = {
    id: "meme-cooking",
    label: "Meme.Cooking finalizable auction view",
    url: "https://meme.cooking/",
    observedAt: Date.now(),
  };
  const count =
    finalizable[0]?.status === "fulfilled" && Array.isArray(finalizable[0].value.value)
      ? finalizable[0].value.value.length
      : null;
  const items = poolItems(selected, [], 5).map((item) => ({
    ...item,
    title: `Meme market · ${item.title}`,
    note: "Meme.Cooking subaccount token listed in a RHEA pool. Pool sequence is not a verified launch date. Taxes, holders, admin powers and future exit ability are not established.",
  }));
  return {
    items,
    sources: [pools.source, source],
    summary: `Read current RHEA-listed Meme.Cooking token pools${count === null ? "; the auction view was unavailable" : ` and observed ${count} currently finalizable auction(s)`}. These are research candidates, not safety ratings; Nearly/other factory launches are not inferred from ticker names.`,
  };
}
