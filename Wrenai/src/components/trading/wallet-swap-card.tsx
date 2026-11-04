"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw, TriangleAlert, X } from "lucide-react";
import { m, useReducedMotion } from "motion/react";
import { type ReactElement, useState, useTransition } from "react";
import { ActivityIndicator } from "@/components/ui/activity-indicator";
import { Button } from "@/components/ui/button";
import { walletTransactionHash } from "@/components/wallet/transaction-hash";
import {
  dismissWalletSwap,
  recordWalletSwap,
  requestWalletSwap,
  startWalletSwap,
} from "@/server/manual-trading/actions";
import type { TradingResult } from "@/shared/manual-trading";
import { type WalletSwapView, walletSwapTransaction, walletSwapViewSchema } from "@/shared/wallet-swap";
import { QuoteTimer, SwapSummary, tokenAmount } from "./swap-summary";
import { readTrading } from "./trading-api";

const ICON = { "aria-hidden": true, size: 16, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

function value<T>(result: TradingResult<T>): T {
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value;
}

/** Wallet cancels and closed popups read as "not sent", never as a failure (Docs/LESSONS.md → NEAR Connect). */
function walletMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  return /reject|cancel|closed|denied|abort/i.test(text)
    ? "Not sent. Approve the swap in your wallet to continue."
    : error instanceof Error && text.length > 0 && text.length < 160
      ? text
      : "The wallet didn't send the swap. Nothing moved.";
}

/**
 * A swap paid straight from the wallet. Confirm opens the wallet once to send the exact NEAR to 1Click's deposit
 * address; 1Click swaps it and pays the output to the same wallet. The card then follows 1Click's status.
 */
export function WalletSwapCard({ id }: { readonly id: string }): ReactElement {
  const cache = useQueryClient(),
    reduced = useReducedMotion();
  const [currentId, setCurrentId] = useState(id),
    [error, setError] = useState<string | null>(null),
    [busy, startTransition] = useTransition();
  const query = useQuery({
    queryKey: ["wallet-swap", currentId],
    queryFn: ({ signal }) =>
      readTrading(`/api/trading/wallet-swaps/${encodeURIComponent(currentId)}`, walletSwapViewSchema, signal),
    staleTime: 1000,
    refetchInterval: (q) => (q.state.data?.state === "submitted" ? 3000 : false),
    retry: false,
  });
  const swap = query.data;

  function run(kind: "confirm" | "refresh" | "dismiss"): void {
    if (!swap || busy) {
      return;
    }
    const snapshot = swap;
    startTransition(async () => {
      setError(null);
      try {
        if (kind === "dismiss") {
          value(await dismissWalletSwap({ id: snapshot.id }));
          cache.setQueryData<WalletSwapView>(["wallet-swap", currentId], { ...snapshot, state: "cancelled" });
          return;
        }
        if (kind === "refresh") {
          const fresh = value(
            await requestWalletSwap({ ...snapshot.quote.request, requestId: crypto.randomUUID() }),
          );
          cache.setQueryData(["wallet-swap", fresh.id], fresh);
          setCurrentId(fresh.id);
          return;
        }
        const started = value(await startWalletSwap({ id: snapshot.id }));
        const { walletForAccount } = await import("@/components/wallet/near-connector");
        const wallet = await walletForAccount(started.quote.accountId, "authorize", () => {});
        if (!wallet.ok) {
          setError(wallet.notice.text);
          return;
        }
        const transaction = walletSwapTransaction(started.quote);
        let hash: string;
        try {
          const reply = await wallet.value.signAndSendTransaction({
            ...transaction,
            actions: transaction.actions.map((action) => ({ ...action, params: { ...action.params } })),
          });
          hash = walletTransactionHash.parse(reply);
        } catch (walletError) {
          setError(walletMessage(walletError));
          return;
        }
        const recorded = value(await recordWalletSwap({ id: snapshot.id, transactionHash: hash }));
        cache.setQueryData(["wallet-swap", currentId], recorded);
      } catch (failure) {
        setError(
          failure instanceof Error ? failure.message : "The swap couldn't be updated. Check it again.",
        );
      }
    });
  }

  if (!swap) {
    return (
      <div role="status" className="w-full max-w-sm card-shine rounded-lg p-3.5 text-small text-fg-muted">
        {query.error?.message ?? <ActivityIndicator label="Loading swap" />}
      </div>
    );
  }
  const { quote } = swap;
  const open = swap.state === "quoted" || swap.state === "signing";
  return (
    <m.section
      initial={reduced ? false : { opacity: 0, y: 8, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: reduced ? 0 : 0.36, ease: [0.32, 0.72, 0, 1] }}
      aria-label="Swap from wallet"
      className="flex w-full max-w-sm flex-col gap-3 card-shine rounded-lg p-3.5"
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-small font-medium text-fg-strong">Swap</h3>
          <span className="truncate text-caption text-fg-subtle">From wallet · 1Click</span>
        </div>
        {open ? (
          <div className="-mr-1 flex shrink-0 items-center gap-1">
            <QuoteTimer expiresAt={swap.expiresAt} />
            {swap.state === "quoted" ? (
              <button
                type="button"
                onClick={() => run("dismiss")}
                aria-label="Dismiss quote"
                title="Dismiss quote"
                className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-subtle transition-[background-color,color,scale] duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong active:scale-90 motion-reduce:active:scale-100 pointer-coarse:size-11"
              >
                <X {...ICON} size={14} />
              </button>
            ) : null}
          </div>
        ) : null}
      </header>
      <SwapSummary
        input={quote.input}
        output={quote.output}
        inputUnits={quote.inputUnits}
        outputUnits={quote.outputUnits}
        minimumOutputUnits={quote.minimumOutputUnits}
        settled={
          swap.state === "settled" && swap.receivedUnits
            ? { spentUnits: quote.inputUnits, receivedUnits: swap.receivedUnits }
            : undefined
        }
      />
      {error ? (
        <p role="alert" className="text-caption text-warn">
          {error}
        </p>
      ) : null}
      <WalletSwapFooter swap={swap} busy={busy} onRun={run} />
    </m.section>
  );
}

interface FooterProps {
  readonly swap: WalletSwapView;
  readonly busy: boolean;
  readonly onRun: (kind: "confirm" | "refresh" | "dismiss") => void;
}

function WalletSwapFooter({ swap, busy, onRun }: FooterProps): ReactElement {
  const { quote } = swap;
  if (swap.state === "quoted" || swap.state === "signing") {
    return (
      <div className="flex flex-col gap-2">
        <div className="grid">
          <Button type="button" variant="primary" aria-busy={busy} onClick={() => onRun("confirm")}>
            {busy ? <ActivityIndicator size={18} label="Waiting for your wallet" /> : "Confirm swap"}
          </Button>
        </div>
        <p className="text-center text-caption text-fg-subtle">
          Your wallet asks once to send {tokenAmount(quote.inputUnits, quote.input)} NEAR.
        </p>
      </div>
    );
  }
  if (swap.state === "expired") {
    return (
      <div className="grid">
        <Button type="button" variant="soft" aria-busy={busy} onClick={() => onRun("refresh")}>
          {busy ? (
            <ActivityIndicator size={18} label="Refreshing quote" />
          ) : (
            <>
              <RefreshCw {...ICON} />
              Refresh quote
            </>
          )}
        </Button>
      </div>
    );
  }
  const line =
    swap.state === "submitted"
      ? { icon: <ActivityIndicator size={14} label="Swapping" />, text: "Swapping. Usually under a minute." }
      : swap.state === "settled"
        ? {
            icon: <Check {...ICON} size={14} className="text-accent-text" />,
            text: `Received ${swap.receivedUnits ? tokenAmount(swap.receivedUnits, quote.output) : ""} ${quote.output.tokenSymbol} in your wallet.`,
          }
        : swap.state === "refunded"
          ? {
              icon: <RefreshCw {...ICON} size={14} />,
              text: "The swap couldn't fill. Your NEAR was refunded as wNEAR.",
            }
          : swap.state === "failed"
            ? {
                icon: <TriangleAlert {...ICON} size={14} className="text-warn" />,
                text: "1Click reported a failed swap. Check your wallet's history.",
              }
            : { icon: null, text: "Quote dismissed." };
  return (
    <p role="status" className="inline-flex items-center gap-2 text-caption text-fg-muted">
      {line.icon}
      {line.text}
    </p>
  );
}
