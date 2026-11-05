"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { m, useReducedMotion } from "motion/react";
import { type ReactElement, useEffect, useRef, useState, useTransition } from "react";
import { CopyButton } from "@/components/chat/copy-button";
import { ActivityIndicator } from "@/components/ui/activity-indicator";
import { Button } from "@/components/ui/button";
import { notify, type ToastTone } from "@/components/ui/toast";
import { walletNotice } from "@/components/wallet/notices";
import { walletTransactionHash } from "@/components/wallet/transaction-hash";
import {
  dismissWalletSwap,
  recordWalletSwap,
  requestWalletSwap,
  startWalletSwap,
} from "@/server/manual-trading/actions";
import type { TradingResult } from "@/shared/manual-trading";
import { PORTFOLIO_WALLET_KEY } from "@/shared/portfolio-wallet";
import {
  type WalletSwapView,
  walletSwapProofSchema,
  walletSwapTransaction,
  walletSwapViewSchema,
} from "@/shared/wallet-swap";
import { notifyQuoteFailure } from "./quote-feedback";
import { QuoteTimer, SwapSummary } from "./swap-summary";
import { readTrading } from "./trading-api";
import {
  type WalletApproval,
  type WalletSwapAction,
  WalletSwapFooter,
  walletSwapNotice,
} from "./wallet-swap-footer";

const ICON = { "aria-hidden": true, size: 16, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;
const ACTION_ERRORS: Readonly<Record<WalletSwapAction, string>> = {
  confirm: "Couldn't start approval.",
  refresh: "Quote unavailable.",
  dismiss: "Couldn't dismiss quote.",
  check: "Couldn't check deposit.",
};

/**
 * A swap paid straight from the wallet. Confirm opens the wallet once for the exact reviewed transaction. The
 * card then follows either 1Click's deposit status or the saved RHEA transaction hash to a final result.
 */
export function WalletSwapCard({ id }: { readonly id: string }): ReactElement {
  const cache = useQueryClient(),
    reduced = useReducedMotion();
  const [currentId, setCurrentId] = useState(id),
    [error, setError] = useState<string | null>(null),
    [recoveryHash, setRecoveryHash] = useState(""),
    [approval, setApproval] = useState<WalletApproval | null>(null),
    [busy, startTransition] = useTransition();
  const query = useQuery({
    queryKey: ["wallet-swap", currentId],
    queryFn: ({ signal }) =>
      readTrading(`/api/trading/wallet-swaps/${encodeURIComponent(currentId)}`, walletSwapViewSchema, signal),
    staleTime: 5000,
    refetchInterval: (q) => {
      const value = q.state.data;
      if (value?.state === "quoted") {
        return Math.max(1000, value.expiresAt - Date.now());
      }
      return value?.state === "submitted" ? 3000 : false;
    },
    retry: false,
  });
  const swap = query.data;
  const readError = query.error?.message ?? null;
  const observedSwap = useRef<{ readonly id: string; readonly states: Set<WalletSwapView["state"]> } | null>(
    null,
  );
  const observedReadError = useRef<string | null>(null);
  const hasSwap = swap !== undefined;

  useEffect(() => {
    if (!swap) {
      return;
    }
    const observed = observedSwap.current;
    if (observed?.id !== swap.id) {
      observedSwap.current = { id: swap.id, states: new Set([swap.state]) };
      return;
    }
    if (!observed.states.has(swap.state)) {
      observed.states.add(swap.state);
      if (swap.state === "settled" || swap.state === "refunded") {
        void cache.invalidateQueries({ queryKey: PORTFOLIO_WALLET_KEY });
      }
      const notice = walletSwapNotice(swap);
      if (notice) {
        notify(notice.tone, notice.text);
      }
    }
  }, [cache, swap]);

  useEffect(() => {
    if (readError && readError !== observedReadError.current) {
      notify("warn", hasSwap ? "Couldn't check swap status." : "Couldn't load swap.");
    }
    observedReadError.current = readError;
  }, [hasSwap, readError]);

  function reportError(message: string, text = message, tone: ToastTone = "warn"): void {
    setError(message);
    notify(tone, text);
  }

  function accept<T>(result: TradingResult<T>, fallback: string): T | undefined {
    if (result.ok) {
      return result.value;
    }
    reportError(result.message, result.code === "signed_out" ? "Sign in to continue." : fallback);
    return undefined;
  }

  function run(kind: WalletSwapAction): void {
    if (!swap || busy) {
      return;
    }
    const snapshot = swap;
    startTransition(async () => {
      setError(null);
      let failure = ACTION_ERRORS[kind];
      try {
        if (kind === "check") {
          const hash =
            approval?.kind === "sent"
              ? approval.hash
              : snapshot.quote.depositKind === "rhea_native"
                ? recoveryHash.trim()
                : "";
          if (hash && snapshot.state === "signing") {
            const proof = walletSwapProofSchema.safeParse({ id: snapshot.id, transactionHash: hash });
            if (!proof.success) {
              reportError("Enter the complete NEAR transaction hash.", ACTION_ERRORS.check);
              return;
            }
            const recorded = accept(
              await recordWalletSwap({
                ...proof.data,
                ...(approval?.kind === "sent" ? {} : { fromRecovery: true }),
              }),
              ACTION_ERRORS.check,
            );
            if (recorded) {
              cache.setQueryData(["wallet-swap", currentId], recorded);
            }
          } else {
            const result = await query.refetch();
            if (!result.error && result.data?.state === "signing") {
              notify(
                "info",
                snapshot.quote.depositKind === "rhea_native"
                  ? "Waiting for transaction hash."
                  : "Deposit pending.",
              );
            }
          }
          return;
        }
        if (kind === "dismiss") {
          if (accept(await dismissWalletSwap({ id: snapshot.id }), ACTION_ERRORS.dismiss) !== undefined) {
            cache.setQueryData<WalletSwapView>(["wallet-swap", currentId], {
              ...snapshot,
              state: "cancelled",
            });
          }
          return;
        }
        if (kind === "refresh") {
          const result = await requestWalletSwap({
            ...snapshot.quote.request,
            requestId: crypto.randomUUID(),
          });
          if (!result.ok) {
            setError(result.message);
            notifyQuoteFailure(result.code);
            return;
          }
          const fresh = result.value;
          cache.setQueryData(["wallet-swap", fresh.id], fresh);
          setApproval(null);
          setRecoveryHash("");
          setCurrentId(fresh.id);
          if (fresh.state === "quoted") {
            notify("success", "Quote refreshed.");
          }
          return;
        }
        const { walletForAccount } = await import("@/components/wallet/near-connector");
        const wallet = await walletForAccount(snapshot.quote.accountId, "authorize", () => {});
        if (!wallet.ok) {
          reportError(wallet.notice.text, wallet.notice.text, wallet.notice.tone);
          return;
        }
        const result = await startWalletSwap({ id: snapshot.id });
        if (!result.ok && result.code === "conflict") {
          const latest = await query.refetch();
          if (!latest.error && latest.data && latest.data.state !== "quoted") {
            if (latest.data.state === "signing") {
              notify("info", "Approval already started.");
            }
            return;
          }
        }
        const started = accept(result, ACTION_ERRORS.confirm);
        if (!started) {
          return;
        }
        cache.setQueryData(["wallet-swap", currentId], started);
        const transaction = walletSwapTransaction(started.quote);
        let reply: unknown;
        try {
          reply = await wallet.value.signAndSendTransaction({
            ...transaction,
            actions: [...transaction.actions],
          });
        } catch (walletError) {
          if (walletNotice(walletError, "authorize").tone === "info") {
            setApproval({ kind: "declined" });
            notify("info", "Approval cancelled.");
          } else {
            reportError("Check the deposit status before sending again.", "Wallet approval unconfirmed.");
          }
          return;
        }
        const hash = walletTransactionHash.safeParse(reply);
        const proof = walletSwapProofSchema.safeParse({
          id: snapshot.id,
          transactionHash: hash.success ? hash.data : null,
        });
        if (!proof.success) {
          reportError("Check the deposit status before sending again.", "Transaction hash unavailable.");
          return;
        }
        setApproval({ kind: "sent", hash: proof.data.transactionHash });
        failure = ACTION_ERRORS.check;
        const recorded = accept(await recordWalletSwap(proof.data), ACTION_ERRORS.check);
        if (recorded) {
          cache.setQueryData(["wallet-swap", currentId], recorded);
        }
      } catch {
        reportError(failure);
      }
    });
  }

  if (!swap) {
    return (
      <div className="flex w-full max-w-sm flex-col gap-2 card-shine rounded-lg p-3.5 text-small text-fg-muted">
        {readError ? (
          <>
            <p role="alert">{readError}</p>
            <Button type="button" variant="soft" disabled={query.isFetching} onClick={() => query.refetch()}>
              Retry
            </Button>
          </>
        ) : (
          <ActivityIndicator label="Loading swap" />
        )}
      </div>
    );
  }
  const { quote } = swap;
  const open = swap.state === "quoted";
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
          <span className="truncate text-caption text-fg-subtle">
            From wallet · {quote.depositKind === "rhea_native" ? "RHEA" : "1Click"}
          </span>
        </div>
        {open ? (
          <div className="-mr-1 flex shrink-0 items-center gap-1">
            <QuoteTimer expiresAt={swap.expiresAt} />
            <button
              type="button"
              onClick={() => run("dismiss")}
              aria-label="Dismiss quote"
              title="Dismiss quote"
              className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-subtle transition-[background-color,color,scale] duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong active:scale-90 motion-reduce:active:scale-100 pointer-coarse:size-11"
            >
              <X {...ICON} size={14} />
            </button>
          </div>
        ) : swap.transactionHash ? (
          <CopyButton text={swap.transactionHash} label="Copy transaction hash" />
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
            ? { spentUnits: swap.spentUnits ?? quote.inputUnits, receivedUnits: swap.receivedUnits }
            : undefined
        }
      />
      {error || query.error ? (
        <p role="alert" className="text-caption text-warn">
          {error ?? query.error?.message}
        </p>
      ) : null}
      <WalletSwapFooter
        swap={swap}
        approval={approval}
        busy={busy}
        recoveryHash={recoveryHash}
        onRecoveryHashChange={setRecoveryHash}
        onRun={run}
      />
    </m.section>
  );
}
