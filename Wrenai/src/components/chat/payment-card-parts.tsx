import { Check, Clock, Eye, LoaderCircle, Lock, type LucideIcon, TriangleAlert } from "lucide-react";
import { type ReactElement, type ReactNode, useId } from "react";
import { CopyButton } from "@/components/chat/copy-button";
import { TRADING_INPUT } from "@/components/trading/fields";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { budgetTokenAmount } from "@/shared/agent-budget";
import type { PaymentOffer, WalletPaymentView } from "@/shared/chat-payment";
import { NEAR_TX_HASH } from "@/shared/manual-trading";
import { middleTruncate } from "@/shared/truncate";
import type { PaymentTopUpView } from "@/shared/wallet-swap";

const ICON = { "aria-hidden": true, size: 14, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

/** One compact word for where the payment is; the quote timer takes this place while a quote is open. */
export function PaymentBadge({
  wallet,
  topUp,
  declined,
}: {
  readonly wallet: WalletPaymentView | null | undefined;
  readonly topUp: PaymentTopUpView | null | undefined;
  /** The wallet said no: the saved state still reads "signing", but nothing is waiting any more. */
  readonly declined: boolean;
}): ReactElement | null {
  const badge = ((): { readonly tone: BadgeTone; readonly label: string } | null => {
    if (declined && (topUp ?? wallet)?.state === "signing") {
      return { tone: "neutral", label: "Cancelled" };
    }
    if (topUp) {
      if (topUp.reviewRequired) {
        return { tone: "warn", label: "Review needed" };
      }
      switch (topUp.state) {
        case "signing":
        case "submitted":
        case "settled":
          return { tone: "warn", label: "Sending" };
        case "refunded":
          return { tone: "neutral", label: "Refunded" };
        case "failed":
          return { tone: "loss", label: "Failed" };
        case "expired":
        case "cancelled":
          return { tone: "neutral", label: "Closed" };
        default:
          return null;
      }
    }
    switch (wallet?.state) {
      case "signing":
      case "submitted":
        return { tone: "warn", label: "Waiting" };
      case "settled":
        return { tone: "accent", label: "Sent" };
      case "failed":
        return { tone: "loss", label: "Failed" };
      case "expired":
      case "cancelled":
        return { tone: "neutral", label: "Expired" };
      default:
        return null;
    }
  })();
  return badge ? (
    <Badge tone={badge.tone} dot>
      {badge.label}
    </Badge>
  ) : null;
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="break-all text-right font-mono tabular-nums text-fg-strong">{children}</dd>
    </div>
  );
}

/**
 * The payment in one well: the amount as the key figure, the recipient with copy, then the route's terms. Amounts
 * are the exact reviewed units; nothing here is estimated.
 */
export function PaymentSummary({
  offer,
  wallet,
  topUp,
}: {
  readonly offer: PaymentOffer;
  readonly wallet: WalletPaymentView | null | undefined;
  readonly topUp: PaymentTopUpView | null | undefined;
}): ReactElement {
  const registration =
    wallet && wallet.quote.registrationUnits !== "0" ? wallet.quote.registrationUnits : null;
  const storage =
    topUp?.quote.storageDepositUnits && topUp.quote.storageDepositUnits !== "0"
      ? topUp.quote.storageDepositUnits
      : null;
  return (
    <div className="flex flex-col gap-3 rounded-md bg-sunken p-3 ring-1 ring-line-card ring-inset">
      <div className="flex flex-col gap-1">
        <p className="font-mono text-num-lg tabular-nums break-all text-fg-strong">
          {offer.amount} <span className="text-fg-muted">{offer.symbol}</span>
        </p>
        <p className="flex min-w-0 items-center gap-1 text-small text-fg-muted">
          <span className="shrink-0">to</span>
          <span title={offer.recipient} className="min-w-0 truncate font-mono text-fg">
            {offer.recipient}
          </span>
          <CopyButton text={offer.recipient} label="Copy recipient" />
        </p>
      </div>
      {topUp || wallet ? (
        <dl className="flex flex-col gap-1.5 border-t border-line-card pt-2.5 text-caption">
          {topUp ? (
            <>
              <Row label="Wallet deposit">
                {budgetTokenAmount(topUp.quote.inputUnits, topUp.quote.input.decimals)}{" "}
                {topUp.quote.input.tokenSymbol}
              </Row>
              <Row label="Private credit">
                {budgetTokenAmount(topUp.quote.outputUnits, topUp.quote.input.decimals)}{" "}
                {topUp.quote.input.tokenSymbol}
              </Row>
              <Row label="Max private debit">
                {budgetTokenAmount(topUp.maximumDebitUnits, topUp.quote.input.decimals)}{" "}
                {topUp.quote.input.tokenSymbol}
              </Row>
              {storage ? <Row label="Registration">up to {budgetTokenAmount(storage, 24)} NEAR</Row> : null}
            </>
          ) : registration ? (
            <Row label="Registration">up to {budgetTokenAmount(registration, 24)} NEAR</Row>
          ) : null}
          <Row label="Network fee">NEAR gas, in wallet</Row>
          <Row label="Visibility">{topUp ? "Deposit public, payment private" : "Public on NEAR"}</Row>
        </dl>
      ) : null}
    </div>
  );
}

/** A one-line note under an action: a 14 px icon and small muted text, centered (DESIGN.md → Status line). */
export function PaymentNote({
  icon: Icon,
  children,
  tone = "muted",
  spin = false,
}: {
  readonly icon: LucideIcon;
  readonly children: ReactNode;
  readonly tone?: "muted" | "warn" | "accent";
  readonly spin?: boolean;
}): ReactElement {
  const color = tone === "warn" ? "text-warn" : tone === "accent" ? "text-accent-text" : "text-fg-muted";
  return (
    <p role="status" className={`flex items-center justify-center gap-1.5 text-center text-small ${color}`}>
      <Icon {...ICON} className={`shrink-0 ${spin ? "motion-safe:animate-spin" : ""}`} />
      {children}
    </p>
  );
}

export const NOTE_ICONS = { public: Eye, private: Lock, waiting: LoaderCircle } as const;

/** Where a finished payment ended, with its public transaction once there is one. */
export function PaymentOutcome({
  tone,
  text,
  hash,
}: {
  readonly tone: "accent" | "warn" | "muted";
  readonly text: string;
  readonly hash: string | null;
}): ReactElement {
  const Icon = tone === "accent" ? Check : tone === "warn" ? TriangleAlert : Clock;
  const color = tone === "accent" ? "text-accent-text" : tone === "warn" ? "text-warn" : "text-fg-muted";
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <p role="status" className={`inline-flex items-center gap-1.5 text-small ${color}`}>
        <Icon {...ICON} className="shrink-0" />
        {text}
      </p>
      {hash ? (
        <span className="inline-flex items-center gap-0.5">
          <a
            href={`https://nearblocks.io/txns/${hash}`}
            target="_blank"
            rel="noopener noreferrer"
            title={hash}
            aria-label="View transaction on NearBlocks"
            className="rounded-xs font-mono text-caption text-accent-text underline-offset-4 hover:underline"
          >
            {middleTruncate(hash, 6, 4)}
          </a>
          <CopyButton text={hash} label="Copy transaction hash" />
        </span>
      ) : null}
    </div>
  );
}

/** Recovers a payment whose wallet result never came back: the pasted hash is verified on NEAR, never trusted. */
export function HashRecovery({
  text,
  hash,
  busy,
  onChange,
  onVerify,
}: {
  readonly text: string;
  readonly hash: string;
  readonly busy: boolean;
  readonly onChange: (value: string) => void;
  readonly onVerify: () => void;
}): ReactElement {
  const id = useId();
  const valid = NEAR_TX_HASH.safeParse(hash.trim()).success;
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) {
          onVerify();
        }
      }}
    >
      <label htmlFor={id} className="text-caption text-fg-muted">
        {text}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          value={hash}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Paste transaction hash"
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={hash.trim() !== "" && !valid}
          className={`${TRADING_INPUT} min-h-10 flex-1 font-mono text-caption`}
        />
        <Button type="submit" variant="soft" busy={busy} disabled={!valid}>
          Verify
        </Button>
      </div>
    </form>
  );
}
