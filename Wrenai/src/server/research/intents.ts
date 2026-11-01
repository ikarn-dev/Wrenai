import "server-only";
import { z } from "zod";
import type { ResearchInput, ResearchItem, ResearchSource } from "@/shared/research";
import { displayDecimal, price, tokenUnits } from "./decimal";
import { MarketUnavailable, marketJson } from "./market-http";

const tokenSchema = z.object({
  assetId: z.string().max(200),
  decimals: z.coerce.number().int().min(0).max(36),
  blockchain: z.string().max(40),
  symbol: z.string().max(80),
  price: z.string().optional(),
  priceUpdatedAt: z.string().optional(),
  contractAddress: z.string().max(200).optional(),
});
export type IntentToken = z.infer<typeof tokenSchema>;

export async function intentTokens(
  signal?: AbortSignal,
): Promise<{ readonly tokens: readonly IntentToken[]; readonly source: ResearchSource }> {
  const response = await marketJson("NEAR Intents", "https://1click.chaindefuser.com/v0/tokens", {
    cacheMs: 15_000,
    ...(signal ? { signal } : {}),
  });
  return {
    tokens: z.array(tokenSchema).max(5_000).parse(response.value),
    source: {
      id: "intents-tokens",
      label: "1Click asset registry and reference prices",
      url: "https://explorer.near-intents.org/",
      observedAt: response.capturedAt,
    },
  };
}
export function selectToken(tokens: readonly IntentToken[], symbol: string): IntentToken | undefined {
  return (
    tokens.find((token) => token.assetId === symbol) ||
    tokens.find(
      (token) =>
        token.blockchain === "near" &&
        (token.symbol.toUpperCase() === symbol.toUpperCase() ||
          (symbol.toUpperCase() === "NEAR" && token.assetId === "nep141:wrap.near")),
    )
  );
}
export function tokenPriceItems(
  tokens: readonly IntentToken[],
  symbols: readonly string[],
): readonly ResearchItem[] {
  const selected = symbols.length
    ? symbols.flatMap((symbol) => {
        const token = selectToken(tokens, symbol);
        return token ? [token] : [];
      })
    : tokens
        .filter(
          (token) =>
            token.blockchain === "near" &&
            ["WNEAR", "NEAR", "BTC", "WBTC", "ETH", "WETH", "USDC", "USDT"].includes(
              token.symbol.toUpperCase(),
            ),
        )
        .slice(0, 6);
  return selected.map((token) => ({
    id: token.assetId,
    title: `${token.symbol} · ${token.blockchain}`,
    kind: "market",
    status: "indicative",
    metrics: [
      { label: "Reference price", value: token.price ? price(token.price) : "Unavailable" },
      { label: "Price updated", value: token.priceUpdatedAt ?? "Not supplied" },
    ],
    note: `Asset: ${token.assetId}. Registry prices are cached reference data, not executable quotes.`,
    sourceIds: ["intents-tokens"],
  }));
}

export async function drySwapQuote(
  input: ResearchInput,
  signal?: AbortSignal,
): Promise<{ readonly item: ResearchItem; readonly sources: readonly ResearchSource[] }> {
  const registry = await intentTokens(signal);
  const origin = selectToken(registry.tokens, input.symbols[0] ?? "NEAR");
  const destination = selectToken(registry.tokens, input.symbols[1] ?? "USDC");
  if (!origin || !destination || origin.assetId === destination.assetId) {
    throw new MarketUnavailable("This asset pair");
  }
  if (
    input.amountAsset &&
    ![
      origin.symbol.toUpperCase(),
      origin.assetId.toUpperCase(),
      ...(origin.assetId === "nep141:wrap.near" ? ["NEAR"] : []),
    ].includes(input.amountAsset.toUpperCase())
  ) {
    throw new MarketUnavailable("Quote amount denomination");
  }
  const units = tokenUnits(input.amount ?? "1", origin.decimals);
  if (units <= 0n) {
    throw new MarketUnavailable("This amount");
  }
  const credential = z.object({ ONECLICK_JWT: z.string().trim().min(1).max(8_000) }).safeParse(process.env);
  const response = await marketJson("1Click dry quotes", "https://1click.chaindefuser.com/v0/quote", {
    body: {
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 50,
      originAsset: origin.assetId,
      destinationAsset: destination.assetId,
      amount: units.toString(),
      depositType: "INTENTS",
      refundType: "INTENTS",
      recipientType: "INTENTS",
      recipient: "intents.near",
      refundTo: "intents.near",
      deadline: new Date(Date.now() + 120_000).toISOString(),
    },
    ...(credential.success
      ? {
          headers: {
            Authorization: `Bearer ${credential.data.ONECLICK_JWT}`,
            "X-API-Key": credential.data.ONECLICK_JWT,
          },
        }
      : {}),
    ...(signal ? { signal } : {}),
  });
  const quote = z
    .object({
      quote: z.object({
        amountIn: z.string().regex(/^\d{1,78}$/),
        amountOut: z.string().regex(/^\d{1,78}$/),
        minAmountOut: z
          .string()
          .regex(/^\d{1,78}$/)
          .optional(),
        timeEstimate: z.coerce.number().nonnegative().optional(),
      }),
    })
    .parse(response.value).quote;
  if (BigInt(quote.amountIn) !== units || BigInt(quote.amountOut) <= 0n) {
    throw new MarketUnavailable("Quote amount validation");
  }
  return {
    item: {
      id: `dry:${origin.assetId}:${destination.assetId}`,
      title: `${origin.symbol} → ${destination.symbol}`,
      kind: "quote",
      status: "quoted",
      metrics: [
        {
          label: "Input",
          value: `${displayDecimal({ n: BigInt(quote.amountIn), d: 10n ** BigInt(origin.decimals) }, Math.min(origin.decimals, 8))} ${origin.symbol}`,
        },
        {
          label: "Quoted output",
          value: `${displayDecimal({ n: BigInt(quote.amountOut), d: 10n ** BigInt(destination.decimals) }, Math.min(destination.decimals, 8))} ${destination.symbol}`,
        },
        { label: "Slippage setting", value: "0.50%" },
      ],
      note: "Dry preview only; no deposit address, signature or transaction. Route independence, account readiness and excluded costs are not established.",
      sourceIds: ["intents-dry"],
    },
    sources: [
      registry.source,
      {
        id: "intents-dry",
        label: "1Click dry quote",
        url: "https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote",
        observedAt: response.capturedAt,
      },
    ],
  };
}
