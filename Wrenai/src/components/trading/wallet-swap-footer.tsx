"use client";
import { Check, RefreshCw, TriangleAlert } from "lucide-react";
import type { ReactElement } from "react";
import { ActivityIndicator } from "@/components/ui/activity-indicator";
import { Button } from "@/components/ui/button";
import type { ToastTone } from "@/components/ui/toast";
import { budgetTokenAmount } from "@/shared/agent-budget";
import { type WalletSwapView, walletSwapProofSchema } from "@/shared/wallet-swap";
import { TRADING_INPUT } from "./fields";
import { tokenAmount } from "./swap-summary";

const ICON = { "aria-hidden": true, size: 16, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

export type WalletSwapAction = "confirm" | "refresh" | "dismiss" | "check";
export type WalletApproval = { readonly kind: "declined" } | { readonly kind: "sent"; readonly hash: string };

export function walletSwapNotice(
  swap: WalletSwapView,
): { readonly tone: ToastTone; readonly text: string } | null {
  switch (swap.state) {
    case "settled": {
      const { receivedUnits, quote } = swap;
      const amount = receivedUnits && receivedUnits !== "0" ? tokenAmount(receivedUnits, quote.output) : null;
      return {
        tone: "success",
        text: amount
          ? `Received ${amount === "0" ? "<0.000001" : amount} ${quote.output.tokenSymbol}.`
          : "Swap completed.",
      };
    }
    case "submitted":
      return {
        tone: "info",
        text:
          swap.quote.depositKind === "rhea_native"
            ? "Transaction submitted. Verifying native NEAR payout."
            : "Deposit confirmed.",
      };
    case "refunded":
      return { tone: "warn", text: "Swap refunded." };
    case "failed":
      return { tone: "error", text: "Swap failed." };
    case "cancelled":
      return { tone: "info", text: "Quote dismissed." };
    case "expired":
      return { tone: "warn", text: "Quote expired." };
    case "quoted":
    case "signing":
      return null;
  }
}

interface FooterProps {
  readonly swap: WalletSwapView;
  readonly approval: WalletApproval | null;
  readonly busy: boolean;
  readonly recoveryHash: string;
  readonly onRecoveryHashChange: (value: string) => void;
  readonly onRun: (kind: WalletSwapAction) => void;
}

function RefreshQuote({
  busy,
  onRun,
}: {
  readonly busy: boolean;
  readonly onRun: FooterProps["onRun"];
}): ReactElement {
  return (
    <Button type="button" variant="soft" disabled={busy} aria-busy={busy} onClick={() => onRun("refresh")}>
      {busy ? (
        <ActivityIndicator size={18} label="Refreshing quote" />
      ) : (
        <>
          <RefreshCw {...ICON} />
          Refresh quote
        </>
      )}
    </Button>
  );
}

function SigningRecovery({
  swap,
  approval,
  busy,
  recoveryHash,
  onRecoveryHashChange,
  onRun,
}: FooterProps): ReactElement {
  const trimmed = recoveryHash.trim();
  const validHash = walletSwapProofSchema.safeParse({ id: swap.id, transactionHash: trimmed }).success;
  if (approval?.kind === "sent") {
    return (
      <div className="flex flex-col gap-2">
        <p role="status" className="text-caption text-fg-muted">
          Checking native NEAR payout…
        </p>
        {!busy ? (
          <Button type="button" variant="soft" onClick={() => onRun("check")}>
            Check transaction
          </Button>
        ) : null}
      </div>
    );
  }
  if (busy && !trimmed) {
    return (
      <p role="status" className="text-caption text-fg-muted">
        Waiting for wallet approval…
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p role="status" className="text-caption text-fg-muted">
        Check your wallet for the transaction hash.
      </p>
      <input
        aria-label="NEAR transaction hash"
        aria-invalid={trimmed.length > 0 && !validHash}
        autoComplete="off"
        maxLength={64}
        placeholder="Paste transaction hash"
        value={recoveryHash}
        onChange={(event) => onRecoveryHashChange(event.target.value)}
        className={`${TRADING_INPUT} font-mono text-caption`}
      />
      <Button type="button" variant="secondary" disabled={!validHash || busy} onClick={() => onRun("check")}>
        Verify transaction
      </Button>
    </div>
  );
}

/** Status and recovery actions below a wallet swap quote. */
export function WalletSwapFooter(props: FooterProps): ReactElement {
  const { swap, approval, busy, recoveryHash, onRecoveryHashChange, onRun } = props;
  const { quote } = swap;
  if (swap.state === "quoted") {
    return (
      <div className="flex flex-col gap-2">
        <div className="grid">
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            aria-busy={busy}
            onClick={() => onRun("confirm")}
          >
            {busy ? <ActivityIndicator size={18} label="Waiting for your wallet" /> : "Confirm swap"}
          </Button>
        </div>
        <p className="text-center text-caption text-fg-subtle">
          {quote.depositKind === "rhea_native"
            ? "Native NEAR payout · one wallet approval. Pool fee included; network gas separate."
            : quote.depositKind === "native_near"
              ? `Approve one transfer of ${tokenAmount(quote.inputUnits, quote.input)} NEAR.`
              : quote.depositKind === "nep141"
                ? `Approve ${tokenAmount(quote.inputUnits, quote.input)} ${quote.input.tokenSymbol}. Gas and up to ${budgetTokenAmount(quote.storageDepositUnits ?? "0", 24)} NEAR for registration.`
                : `Wrap and send ${tokenAmount(quote.inputUnits, quote.input)} NEAR in one approval.`}
        </p>
      </div>
    );
  }
  if (swap.state === "expired" || (swap.state === "signing" && approval?.kind === "declined")) {
    if (!quote.pairVerified) {
      return (
        <p role="status" className="text-caption text-fg-muted">
          Request a new quote with the exact tokens.
        </p>
      );
    }
    return (
      <div className="grid gap-2">
        <p role="status" className="text-caption text-fg-muted">
          {swap.state === "signing" ? "Approval cancelled." : "Quote expired."}
        </p>
        <RefreshQuote busy={busy} onRun={onRun} />
      </div>
    );
  }
  if (swap.state === "signing" && quote.depositKind === "rhea_native") {
    return (
      <SigningRecovery
        swap={swap}
        approval={approval}
        busy={busy}
        recoveryHash={recoveryHash}
        onRecoveryHashChange={onRecoveryHashChange}
        onRun={onRun}
      />
    );
  }
  if (swap.state === "signing") {
    return (
      <div className="flex flex-col gap-2">
        <p role="status" className="text-caption text-fg-muted">
          {busy ? "Waiting for wallet approval…" : "Waiting for deposit."}
        </p>
        {!busy ? (
          <Button type="button" variant="soft" onClick={() => onRun("check")}>
            Check deposit
          </Button>
        ) : null}
      </div>
    );
  }
  const line =
    swap.state === "submitted"
      ? {
          icon: <ActivityIndicator size={14} label="Verifying" />,
          text:
            quote.depositKind === "rhea_native"
              ? "Transaction submitted. Verifying native NEAR payout…"
              : `Deposit confirmed. Swapping for ${quote.output.tokenSymbol}…`,
        }
      : swap.state === "settled"
        ? {
            icon: <Check {...ICON} size={14} className="text-accent-text" />,
            text: walletSwapNotice(swap)?.text,
          }
        : swap.state === "refunded"
          ? { icon: <RefreshCw {...ICON} size={14} />, text: "Swap refunded." }
          : swap.state === "failed"
            ? {
                icon: <TriangleAlert {...ICON} size={14} className="text-warn" />,
                text: "Swap failed. Check the transaction status.",
              }
            : { icon: null, text: "Quote dismissed." };
  return (
    <p role="status" className="inline-flex items-center gap-2 text-caption text-fg-muted">
      {line.icon}
      {line.text}
    </p>
  );
}
