"use client";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactElement, useId, useState, useTransition } from "react";
import { ActivityIndicator } from "@/components/ui/activity-indicator";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { DEFAULT_SPOT_FEE_BPS } from "@/shared/manual-trading";
import type { SpotMarketToken } from "@/shared/market-pages";
import { decimalDisplay } from "@/shared/trading-display";
import { WALLET_SWAP_INPUT } from "@/shared/wallet-swap";
import { TRADING_INPUT } from "./fields";
import { notifyQuoteFailure } from "./quote-feedback";
import { displaySymbol, networkName } from "./spot-markets-table";
import { Segment, SLIPPAGE, UnitField } from "./ticket-fields";
import { TradeCard } from "./trade-card";
import { TradeDialog, TradeDialogHeader } from "./trade-dialog";
import { requestManualQuote, requestWalletSwap } from "./trading-mutations";
import { WalletSwapCard } from "./wallet-swap-card";

type Source = "wallet" | "private";
type Quote = { readonly kind: "wallet" | "private"; readonly id: string };

interface SpotTradeDialogProps {
  /** The token being bought; null keeps the dialog closed. */
  readonly target: SpotMarketToken | null;
  readonly tokens: readonly SpotMarketToken[];
  readonly onClose: () => void;
}

/**
 * Buying one token: pay NEAR straight from the wallet (one approval, NEAR tokens only) or any token from the
 * NEAR Intents private balance. A quote replaces the form with its swap card, confirmed from there.
 */
export function SpotTradeDialog({ target, tokens, onClose }: SpotTradeDialogProps): ReactElement {
  return (
    <TradeDialog open={target !== null} onClose={onClose}>
      {target ? <TradeForm key={target.assetId} target={target} tokens={tokens} /> : null}
    </TradeDialog>
  );
}

function TradeForm({
  target,
  tokens,
}: {
  readonly target: SpotMarketToken;
  readonly tokens: readonly SpotMarketToken[];
}): ReactElement {
  const payId = useId();
  const cache = useQueryClient();
  // Wallet swaps pay NEAR into 1Click and deliver to the same NEAR account, so they reach NEAR tokens only.
  const walletAllowed = target.blockchain === "near" && target.assetId !== WALLET_SWAP_INPUT;
  const payable = tokens.filter((t) => t.assetId !== target.assetId);
  const [source, setSource] = useState<Source>(walletAllowed ? "wallet" : "private"),
    [pay, setPay] = useState(
      payable.find((t) => t.assetId === WALLET_SWAP_INPUT)?.assetId ?? payable[0]?.assetId ?? "",
    ),
    [slippage, setSlippage] = useState(50),
    [amount, setAmount] = useState(""),
    [quote, setQuote] = useState<Quote | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, startTransition] = useTransition();
  const payToken = payable.find((t) => t.assetId === pay),
    paySymbol = source === "wallet" ? "NEAR" : payToken ? displaySymbol(payToken) : "";

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy) {
      return;
    }
    startTransition(async () => {
      setError(null);
      const requestId = crypto.randomUUID();
      try {
        const result =
          source === "wallet"
            ? await requestWalletSwap({
                requestId,
                amount: amount.trim(),
                outputAssetId: target.assetId,
                slippageBps: slippage,
                maximumFeeBps: DEFAULT_SPOT_FEE_BPS,
              })
            : await requestManualQuote({
                requestId,
                source: "spot",
                intent: {
                  kind: "spot",
                  inputAssetId: pay,
                  outputAssetId: target.assetId,
                  amount: amount.trim(),
                  balance: "confidential",
                  slippageBps: slippage,
                  maximumFeeBps: DEFAULT_SPOT_FEE_BPS,
                },
              });
        if (!result.ok) {
          setError(result.message);
          notifyQuoteFailure(result.code);
          return;
        }
        if (source === "wallet") {
          cache.setQueryData(["wallet-swap", result.value.id], result.value);
          notify("success", "Quote ready.");
        }
        setQuote({ kind: source, id: result.value.id });
      } catch {
        setError("Couldn't get a quote. Try again.");
        notifyQuoteFailure("unavailable");
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <TradeDialogHeader
        symbol={displaySymbol(target)}
        icon={target.metrics?.icon ?? null}
        title={`Buy ${displaySymbol(target)}`}
        detail={target.price ? `$${decimalDisplay(target.price)} · via NEAR Intents` : "via NEAR Intents"}
      />
      {quote ? (
        <div className="flex flex-col gap-3">
          {quote.kind === "wallet" ? (
            <WalletSwapCard id={quote.id} />
          ) : (
            <TradeCard id={quote.id} onClose={() => setQuote(null)} />
          )}
          <button
            type="button"
            onClick={() => setQuote(null)}
            className="self-start rounded-xs text-caption text-fg-muted transition-colors duration-200 ease-ios hover:text-fg-strong"
          >
            Change amount
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" aria-busy={busy}>
          <Segment<Source>
            label="Pay from"
            value={source}
            onChange={setSource}
            options={[
              { value: "wallet", label: "Wallet · NEAR", disabled: !walletAllowed },
              { value: "private", label: "Private balance" },
            ]}
          />
          {source === "private" ? (
            <label htmlFor={payId} className="flex flex-col gap-1.5 text-caption text-fg-subtle">
              Pay with
              <select
                id={payId}
                value={pay}
                onChange={(e) => setPay(e.target.value)}
                className={TRADING_INPUT}
              >
                {payable.map((t) => (
                  <option key={t.assetId} value={t.assetId}>
                    {displaySymbol(t)} · {networkName(t.blockchain)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <UnitField label="Amount" unit={paySymbol} value={amount} onChange={setAmount} required />
          <Segment<number> label="Slippage" value={slippage} onChange={setSlippage} options={SLIPPAGE} />
          {error ? (
            <p role="alert" className="text-caption text-warn">
              {error}
            </p>
          ) : null}
          <div className="grid">
            <Button
              type="submit"
              variant="primary"
              aria-busy={busy}
              disabled={!amount.trim() || (source === "private" && !pay)}
            >
              {busy ? <ActivityIndicator size={18} label="Getting quote" /> : "Get quote"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
