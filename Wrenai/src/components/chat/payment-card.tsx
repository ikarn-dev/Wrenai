"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fuel } from "lucide-react";
import { m, useReducedMotion } from "motion/react";
import { type ReactElement, useState, useTransition } from "react";
import { z } from "zod";
import { QuoteTimer } from "@/components/trading/swap-summary";
import { TradeCard } from "@/components/trading/trade-card";
import { readTrading } from "@/components/trading/trading-api";
import {
  approvePrivateTopUp,
  approvePublicPayment,
  confirmPublicPayment,
  recordPrivateTopUp,
  resumePrivateTopUp,
  reviewPrivatePayment,
  reviewPublicPayment,
} from "@/components/trading/trading-mutations";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { walletNotice } from "@/components/wallet/notices";
import { walletTransactionHash } from "@/components/wallet/transaction-hash";
import { type PaymentOffer, walletPaymentTransaction, walletPaymentViewSchema } from "@/shared/chat-payment";
import {
  DEFAULT_SPOT_FEE_BPS,
  manualPreviewSchema,
  NEAR_TX_HASH,
  type TradingResult,
} from "@/shared/manual-trading";
import { PORTFOLIO_WALLET_KEY } from "@/shared/portfolio-wallet";
import { type PaymentTopUpView, paymentTopUpViewSchema, walletSwapTransaction } from "@/shared/wallet-swap";
import {
  HashRecovery,
  NOTE_ICONS,
  PaymentBadge,
  PaymentNote,
  PaymentOutcome,
  PaymentSummary,
} from "./payment-card-parts";

const paymentState = z.strictObject({
  wallet: walletPaymentViewSchema.nullable(),
  private: manualPreviewSchema.nullable(),
  topUp: paymentTopUpViewSchema.nullable(),
});
type PaymentState = z.output<typeof paymentState>;
type Route = PaymentOffer["routes"][number];

function waitingForPrivatePayment(deposit: PaymentTopUpView): boolean {
  return !deposit.reviewRequired && ["signing", "submitted", "settled"].includes(deposit.state);
}

function result<T>(response: TradingResult<T>): T {
  if (!response.ok) {
    throw new Error(response.message);
  }
  return response.value;
}

/** A fresh review of one route: a non-signing quote that reserves nothing. */
async function reviewRoute(offer: PaymentOffer, route: Route): Promise<PaymentState> {
  const { id, recipient, assetId, amount } = offer;
  if (route === "private") {
    const preview = result(
      await reviewPrivatePayment({
        requestId: id,
        intent: {
          kind: "payment",
          recipient,
          assetId,
          amount,
          slippageBps: 50,
          maximumFeeBps: DEFAULT_SPOT_FEE_BPS,
        },
      }),
    );
    return { wallet: null, ...preview };
  }
  return {
    wallet: result(await reviewPublicPayment({ requestId: id, recipient, assetId, amount })),
    private: null,
    topUp: null,
  };
}

/**
 * The payment's saved state. With a single route there is nothing to choose, so the card reviews it at once and
 * opens on its quote; the review is idempotent on the offer ID, so a reopened chat never makes a second one.
 */
async function loadPayment(offer: PaymentOffer, signal: AbortSignal): Promise<PaymentState> {
  const state = await readTrading(`/api/trading/payments/${offer.id}`, paymentState, signal);
  const [only] = offer.routes;
  if (state.wallet || state.private || state.topUp || offer.routes.length !== 1 || !only) {
    return state;
  }
  return reviewRoute(offer, only);
}

export function PaymentCard({ offer }: { readonly offer: PaymentOffer }): ReactElement {
  const cache = useQueryClient(),
    reduced = useReducedMotion();
  const key = ["chat-payment", offer.id];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => loadPayment(offer, signal),
    retry: false,
    staleTime: 5_000,
    refetchInterval: ({ state }) => {
      const deposit = state.data?.topUp;
      if (deposit && waitingForPrivatePayment(deposit) && !state.data?.private?.actionId) {
        return 5000;
      }
      const view = deposit ?? state.data?.wallet;
      return view?.state === "quoted" ? Math.max(1000, view.expiresAt - Date.now()) : false;
    },
  });
  const wallet = query.data?.wallet;
  const topUp = query.data?.topUp;
  const privatePayment = query.data?.private;
  const active = topUp ?? wallet;
  const [busy, start] = useTransition();
  const [reviewing, setReviewing] = useState<Route | null>(null);
  const [error, setError] = useState<string | null>(null);
  const receiptKey = `jarvis:wallet-payment:${offer.id}`;
  const [hash, setHash] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }
    const saved = NEAR_TX_HASH.safeParse(sessionStorage.getItem(receiptKey));
    return saved.success ? saved.data : "";
  });
  const [declined, setDeclined] = useState(false);

  function run(action: () => Promise<void>): void {
    if (busy) {
      return;
    }
    setError(null);
    start(async () => {
      try {
        await action();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Payment status unavailable.";
        setError(message);
        notify("warn", message);
      }
    });
  }

  function review(route: Route): void {
    setReviewing(route);
    run(async () => {
      cache.setQueryData(key, await reviewRoute(offer, route));
    });
  }

  async function record(id: string, transactionHash: string, isTopUp: boolean): Promise<void> {
    if (isTopUp) {
      const deposit = result(await recordPrivateTopUp({ id, transactionHash }));
      cache.setQueryData(key, { wallet: null, private: null, topUp: deposit });
      sessionStorage.removeItem(receiptKey);
      if (deposit.state === "submitted") {
        notify("info", "Deposit confirmed.");
      }
      await cache.invalidateQueries({ queryKey: PORTFOLIO_WALLET_KEY });
      return;
    }
    const updated = result(await confirmPublicPayment({ id, transactionHash }));
    cache.setQueryData(key, { wallet: updated, private: null, topUp: null });
    sessionStorage.removeItem(receiptKey);
    if (updated.state === "settled") {
      notify("success", `Sent ${offer.amount} ${offer.symbol}.`);
      await cache.invalidateQueries({ queryKey: PORTFOLIO_WALLET_KEY });
    } else if (updated.state === "failed") {
      notify("error", "Payment failed.");
    }
  }

  function approve(): void {
    if (active?.state !== "quoted") {
      return;
    }
    run(async () => {
      const { walletForAccount } = await import("@/components/wallet/near-connector");
      const connected = await walletForAccount(active.quote.accountId, "authorize", () => {});
      if (!connected.ok) {
        throw new Error(connected.notice.text);
      }
      let transaction: ReturnType<typeof walletPaymentTransaction> | ReturnType<typeof walletSwapTransaction>;
      if (topUp) {
        const started = result(await approvePrivateTopUp({ id: topUp.id }));
        cache.setQueryData(key, { wallet: null, private: null, topUp: started });
        transaction = walletSwapTransaction(started.quote);
      } else {
        const started = result(await approvePublicPayment({ id: active.id }));
        cache.setQueryData(key, { wallet: started, private: null, topUp: null });
        transaction = walletPaymentTransaction(started.quote);
      }
      let response: unknown;
      try {
        response = await connected.value.signAndSendTransaction({
          ...transaction,
          actions: [...transaction.actions],
        });
      } catch (cause) {
        if (walletNotice(cause, "authorize").tone === "info") {
          setDeclined(true);
          notify("info", "Approval cancelled.");
          return;
        }
        throw new Error("Wallet status is unknown. Verify the transaction before sending again.");
      }
      const parsed = walletTransactionHash.safeParse(response);
      if (!parsed.success) {
        throw new Error("Transaction hash unavailable. Check your wallet.");
      }
      setHash(parsed.data);
      sessionStorage.setItem(receiptKey, parsed.data);
      await record(active.id, parsed.data, Boolean(topUp));
    });
  }

  /** The one next step for the payment's state; every busy action keeps its button and shows the spinner. */
  function actions(): ReactElement | null {
    if (query.isPending) {
      return (
        <div className="grid">
          <Button variant="primary" busy>
            Confirm payment
          </Button>
        </div>
      );
    }
    if (query.isError) {
      return (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-small text-warn">
            {query.error.message}
          </p>
          <div className="grid">
            <Button variant="soft" busy={query.isFetching} onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        </div>
      );
    }
    if (!active) {
      return (
        <div className={`grid gap-2 ${offer.routes.length > 1 ? "grid-cols-2" : ""}`}>
          {offer.routes.includes("wallet") ? (
            <Button variant="soft" busy={busy && reviewing === "wallet"} onClick={() => review("wallet")}>
              Send publicly
            </Button>
          ) : null}
          {offer.routes.includes("private") ? (
            <Button
              variant="primary"
              busy={busy && reviewing === "private"}
              onClick={() => review("private")}
            >
              Send privately
            </Button>
          ) : null}
        </div>
      );
    }
    if (active.state === "quoted" || (active.state === "signing" && busy)) {
      return (
        <div className="flex flex-col gap-3">
          <div className="grid">
            <Button variant="primary" busy={busy} onClick={approve}>
              {topUp ? "Fund and send" : "Confirm payment"}
            </Button>
          </div>
          {busy ? (
            <PaymentNote icon={NOTE_ICONS.waiting} spin>
              Approve in your wallet…
            </PaymentNote>
          ) : topUp ? (
            <PaymentNote icon={NOTE_ICONS.private}>One wallet approval. The deposit is public.</PaymentNote>
          ) : (
            <PaymentNote icon={Fuel}>One wallet approval. Tiny network fee.</PaymentNote>
          )}
        </div>
      );
    }
    if (active.state === "signing") {
      return declined ? (
        <PaymentOutcome tone="muted" text="Approval cancelled. Ask Jarvis for a fresh payment." hash={null} />
      ) : (
        <HashRecovery
          text={
            topUp
              ? "Waiting for the wallet deposit. Paste its hash to check."
              : "If your wallet sent it, paste the hash to check."
          }
          hash={hash}
          busy={busy}
          onChange={setHash}
          onVerify={() => run(() => record(active.id, hash.trim(), Boolean(topUp)))}
        />
      );
    }
    if (topUp?.reviewRequired) {
      return (
        <PaymentOutcome
          tone="warn"
          text="Needs a fresh review. The deposit stays in your private balance."
          hash={topUp.transactionHash}
        />
      );
    }
    if (topUp && waitingForPrivatePayment(topUp)) {
      return (
        <div className="flex flex-col gap-3">
          <PaymentNote icon={NOTE_ICONS.waiting} spin>
            {topUp.state === "submitted"
              ? "Waiting for the private credit…"
              : "Preparing the private payment…"}
          </PaymentNote>
          <div className="grid">
            <Button
              variant="ghost"
              busy={busy}
              onClick={() =>
                run(async () => {
                  result(await resumePrivateTopUp({ id: topUp.id }));
                  await query.refetch();
                })
              }
            >
              Resume check
            </Button>
          </div>
        </div>
      );
    }
    switch (active.state) {
      case "settled":
        return <PaymentOutcome tone="accent" text="Payment sent" hash={active.transactionHash} />;
      case "failed":
        return (
          <PaymentOutcome
            tone="warn"
            text={topUp ? "Deposit failed. Check it before retrying." : "Payment failed"}
            hash={active.transactionHash}
          />
        );
      case "refunded":
        return <PaymentOutcome tone="muted" text="Deposit refunded" hash={active.transactionHash} />;
      case "submitted":
        return (
          <PaymentNote icon={NOTE_ICONS.waiting} spin>
            Waiting for NEAR to confirm…
          </PaymentNote>
        );
      default:
        return (
          <PaymentOutcome
            tone="muted"
            text="Expired. Ask Jarvis for a fresh payment."
            hash={active.transactionHash}
          />
        );
    }
  }

  if (privatePayment && !wallet && (!topUp || privatePayment.actionId)) {
    return <TradeCard id={privatePayment.id} initial={privatePayment} />;
  }
  const route = topUp ? "Private balance" : wallet ? "Public · NEAR wallet" : "Choose how to send";
  return (
    <m.section
      initial={reduced ? false : { opacity: 0, y: 8, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: reduced ? 0 : 0.36, ease: [0.32, 0.72, 0, 1] }}
      aria-label="Payment review"
      className="flex w-full max-w-sm flex-col gap-3 card-shine rounded-lg p-3.5"
    >
      <header className="flex min-h-6 items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="text-small font-medium text-fg-strong">Payment</h3>
          <span className="truncate text-caption text-fg-subtle">{route}</span>
        </div>
        {active?.state === "quoted" ? (
          <QuoteTimer expiresAt={active.expiresAt} />
        ) : (
          <PaymentBadge wallet={wallet} topUp={topUp} declined={declined} />
        )}
      </header>
      <PaymentSummary offer={offer} wallet={wallet} topUp={topUp} />
      {error ? (
        <p role="alert" className="text-small text-warn">
          {error}
        </p>
      ) : null}
      {actions()}
    </m.section>
  );
}
