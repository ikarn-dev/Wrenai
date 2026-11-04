"use client";
import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { type FormEvent, type ReactElement, useId, useState, useTransition } from "react";
import { ActivityIndicator } from "@/components/ui/activity-indicator";
import { Button } from "@/components/ui/button";
import { requestManualQuote, requestWalletSwap } from "@/server/manual-trading/actions";
import { DEFAULT_SPOT_FEE_BPS } from "@/shared/manual-trading";
import type { SpotMarketToken, TokenIcons } from "@/shared/market-pages";
import { WALLET_SWAP_INPUT } from "@/shared/wallet-swap";
import { TRADING_INPUT } from "./fields";
import { TokenIcon } from "./token-icon";
import { TradeCard } from "./trade-card";
import { WalletSwapCard } from "./wallet-swap-card";

type Source = "wallet" | "private";
type Quote = { readonly kind: "wallet" | "private"; readonly id: string };

const SLIPPAGE = [
  { bps: 25, label: "0.25%" },
  { bps: 50, label: "0.5%" },
  { bps: 100, label: "1%" },
] as const;

function Segment<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly { readonly value: T; readonly label: string; readonly disabled?: boolean }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}): ReactElement {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-caption text-fg-subtle">{label}</legend>
      <div className="grid auto-cols-fr grid-flow-col gap-1 rounded-sm bg-sunken p-1 ring-1 ring-line-card ring-inset">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            disabled={option.disabled}
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
            className={`h-8 cursor-pointer rounded-xs text-caption font-medium transition-colors duration-200 ease-ios disabled:cursor-not-allowed disabled:text-fg-disabled pointer-coarse:h-11 ${option.value === value ? "bg-surface-3 text-fg-strong" : "text-fg-muted hover:text-fg-strong"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

interface SpotTradeDialogProps {
  /** The token being bought; null keeps the dialog closed. */
  readonly target: SpotMarketToken | null;
  readonly tokens: readonly SpotMarketToken[];
  readonly icons: TokenIcons;
  readonly onClose: () => void;
}

/**
 * Buying one token: pay NEAR straight from the wallet (one approval, NEAR tokens only) or any token from the
 * NEAR Intents private balance. A quote replaces the form with its swap card, confirmed from there.
 */
export function SpotTradeDialog({ target, tokens, icons, onClose }: SpotTradeDialogProps): ReactElement {
  return (
    <Dialog.Root open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-bg/80" />
        <Dialog.Content className="fixed inset-x-gutter top-1/2 z-50 mx-auto max-h-[calc(100dvh-2rem)] max-w-sm -translate-y-1/2 overflow-y-auto rounded-xl bg-surface-2 p-card shadow-float">
          {target ? <TradeForm key={target.assetId} target={target} tokens={tokens} icons={icons} /> : null}
          <Dialog.Close
            aria-label="Close"
            className="absolute top-4 right-4 inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-fg-subtle transition-colors duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong pointer-coarse:size-11"
          >
            <X aria-hidden="true" size={16} strokeWidth={1.75} absoluteStrokeWidth />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TradeForm({
  target,
  tokens,
  icons,
}: {
  readonly target: SpotMarketToken;
  readonly tokens: readonly SpotMarketToken[];
  readonly icons: TokenIcons;
}): ReactElement {
  const amountId = useId(),
    payId = useId();
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
  const paySymbol =
    source === "wallet" ? "NEAR" : (payable.find((t) => t.assetId === pay)?.tokenSymbol ?? "");

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy) {
      return;
    }
    startTransition(async () => {
      setError(null);
      const requestId = crypto.randomUUID();
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
        return;
      }
      setQuote({ kind: source, id: result.value.id });
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center gap-2.5 pr-8">
        <TokenIcon symbol={target.tokenSymbol} icon={icons[target.assetId]} size={28} />
        <div className="flex min-w-0 flex-col">
          <Dialog.Title className="truncate font-rounded text-h2 font-bold text-fg-strong">
            Buy {target.tokenSymbol}
          </Dialog.Title>
          <Dialog.Description className="text-caption text-fg-subtle">
            {target.price ? `$${target.price} · ` : ""}via NEAR Intents
          </Dialog.Description>
        </div>
      </header>
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
                    {t.tokenSymbol} · {t.blockchain}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label htmlFor={amountId} className="flex flex-col gap-1.5 text-caption text-fg-subtle">
            Amount
            <span className="flex items-center rounded-sm bg-sunken ring-1 ring-line-strong ring-inset focus-within:ring-2 focus-within:ring-accent">
              <input
                id={amountId}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                required
                className="min-h-11 w-full min-w-0 bg-transparent px-3 font-mono text-body tabular-nums text-fg-strong outline-none"
              />
              <span className="shrink-0 pr-3 text-caption font-medium text-fg-muted">{paySymbol}</span>
            </span>
          </label>
          <Segment<number>
            label="Slippage"
            value={slippage}
            onChange={setSlippage}
            options={SLIPPAGE.map((s) => ({ value: s.bps, label: s.label }))}
          />
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
