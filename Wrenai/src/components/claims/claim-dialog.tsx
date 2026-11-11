"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useLenis } from "lenis/react";
import { Eye, LoaderCircle } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { type ReactElement, useEffect, useRef, useState, useTransition } from "react";
import { agentCommandRequest } from "@/components/agents/review-api";
import { QuoteTimer, tokenAmount } from "@/components/trading/swap-summary";
import { postTrading } from "@/components/trading/trading-api";
import { Button } from "@/components/ui/button";
import { budgetTokenAmount } from "@/shared/agent-budget";
import { type ClaimRow, PENDING_CLAIMS_KEY, type ReceiveOption, WNEAR_ASSET_ID } from "@/shared/claims";
import { DEFAULT_SPOT_FEE_BPS, type ManualPreview, manualPreviewSchema } from "@/shared/manual-trading";
import { addFlow, useClaimsStore, useStoreValue } from "./flow-store";
import { type ReceiveChoice, ReceivePicker } from "./receive-picker";

const SPIN = { size: 18, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;
// A same-token claim costs only 1Click's fee; a swap into another token needs room for price movement.
const SAME_TOKEN_SLIPPAGE_BPS = 10;
const SWAP_SLIPPAGE_BPS = 50;

function receiveAsset(choice: ReceiveChoice): string {
  return choice === "near" ? WNEAR_ASSET_ID : choice;
}

function initialChoice(row: ClaimRow): ReceiveChoice {
  const chosen = row.agent?.returnAssetId;
  return chosen === undefined || chosen === null
    ? row.agent?.claimingSince != null
      ? "held"
      : "near"
    : chosen === WNEAR_ASSET_ID
      ? "near"
      : chosen;
}

function title(row: ClaimRow): string {
  if (row.agent) {
    return row.agent.claimingSince === null ? `Claim from ${row.agent.name}?` : "Change receive token?";
  }
  const amount = row.claimable[0];
  return amount && amount.decimals !== null
    ? `Claim ${budgetTokenAmount(amount.units, amount.decimals)} ${amount.symbol}?`
    : "Claim this balance?";
}

function Review({ quote }: { readonly quote: ManualPreview }): ReactElement {
  const rows = [
    { label: "You send", value: quote.maximumDebit },
    ...(quote.output && quote.minimumOutputUnits
      ? [
          {
            label: "You receive at least",
            value: `${tokenAmount(quote.minimumOutputUnits, quote.output)} ${quote.output.tokenSymbol}`,
          },
        ]
      : []),
  ];
  return (
    <div className="flex flex-col gap-2">
      <dl className="flex flex-col gap-1.5 rounded-sm bg-sunken px-3 py-2.5 text-small ring-1 ring-line-card ring-inset">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-4">
            <dt className="text-fg-subtle">{row.label}</dt>
            <dd className="font-mono tabular-nums text-fg-strong">{row.value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center justify-between gap-3">
        <details className="text-caption text-fg-subtle">
          <summary className="cursor-pointer list-none hover:text-fg-strong [&::-webkit-details-marker]:hidden">
            Fees and terms
          </summary>
          <p className="mt-2 max-w-sm">{quote.feeNote}</p>
        </details>
        <QuoteTimer expiresAt={quote.expiresAt} />
      </div>
    </div>
  );
}

function ClaimForm({
  row,
  options,
  close,
}: {
  readonly row: ClaimRow;
  readonly options: readonly ReceiveOption[];
  readonly close: () => void;
}): ReactElement {
  const cache = useQueryClient(),
    store = useClaimsStore();
  const [choice, setChoice] = useState<ReceiveChoice>(() => initialChoice(row)),
    [quote, setQuote] = useState<ManualPreview | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, startTransition] = useTransition();
  // One request per choice, so a retry after a lost reply never records a second delete.
  const request = useRef<{ readonly choice: ReceiveChoice; readonly id: string } | null>(null);
  const held = row.claimable[0];
  const expired = quote !== null && quote.expiresAt <= Date.now();

  function run(task: () => Promise<string | null>): void {
    if (busy) {
      return;
    }
    startTransition(async () => {
      setError(null);
      try {
        setError(await task());
      } catch {
        setError("Couldn't reach Wrenai. Try again.");
      }
    });
  }
  function claimAgent(): void {
    const agent = row.agent;
    if (!agent) {
      return;
    }
    if (request.current?.choice !== choice) {
      request.current = { choice, id: crypto.randomUUID() };
    }
    const requestId = request.current.id;
    run(async () => {
      const result = await agentCommandRequest(agent.id, {
        requestId,
        agentId: agent.id,
        expectedRevision: agent.revision,
        command: "claim",
        receiveAssetId: choice === "held" ? "held" : receiveAsset(choice),
      });
      if (!result.ok) {
        return result.message;
      }
      await Promise.all([
        cache.invalidateQueries({ queryKey: PENDING_CLAIMS_KEY }),
        cache.invalidateQueries({ queryKey: ["agents"] }),
        cache.invalidateQueries({ queryKey: ["agent-runtime"] }),
      ]);
      close();
      return null;
    });
  }
  function quotePrivate(): void {
    if (!held || held.decimals === null) {
      setError("This token's precision is unknown, so it can't be claimed here.");
      return;
    }
    const decimals = held.decimals,
      to = receiveAsset(choice);
    run(async () => {
      const result = await postTrading(
        "/api/claims/order",
        {
          step: "quote",
          input: {
            requestId: crypto.randomUUID(),
            source: "portfolio",
            intent: {
              kind: "wallet_return",
              assetId: held.assetId,
              ...(to === held.assetId ? {} : { receiveAssetId: to }),
              amount: budgetTokenAmount(held.units, decimals),
              slippageBps: to === held.assetId ? SAME_TOKEN_SLIPPAGE_BPS : SWAP_SLIPPAGE_BPS,
              maximumFeeBps: DEFAULT_SPOT_FEE_BPS,
            },
          },
        },
        manualPreviewSchema,
      );
      if (!result.ok) {
        return result.message;
      }
      setQuote(result.value);
      return null;
    });
  }
  function confirmPrivate(preview: ManualPreview): void {
    run(async () => {
      const result = await postTrading(
        "/api/claims/order",
        {
          step: "confirm",
          input: { id: preview.id, revision: preview.revision, bindingHash: preview.bindingHash },
        },
        manualPreviewSchema,
      );
      if (!result.ok) {
        return result.message;
      }
      cache.setQueryData(["manual-order", result.value.id], result.value);
      addFlow(store, {
        id: result.value.id,
        row,
        order: result.value,
        confirmedAt: Date.now(),
        unwrap: choice === "near",
      });
      await cache.invalidateQueries({ queryKey: PENDING_CLAIMS_KEY });
      close();
      return null;
    });
  }

  const agent = row.agent;
  const primary = agent
    ? {
        label:
          agent.claimingSince !== null
            ? "Save"
            : agent.status === "running" || agent.status === "paused"
              ? "Stop and claim"
              : "Claim",
        run: claimAgent,
      }
    : quote && !expired
      ? {
          label: "Confirm claim",
          // An expired card gets a fresh quote instead of a refused confirmation.
          run: () => (quote.expiresAt <= Date.now() ? quotePrivate() : confirmPrivate(quote)),
        }
      : { label: quote ? "Refresh quote" : "Get quote", run: quotePrivate };
  return (
    <>
      <AlertDialog.Description className="mt-2 text-body text-fg-muted">
        {agent
          ? agent.claimingSince !== null
            ? "Funds still on the way arrive in the token you choose."
            : agent.status === "running" || agent.status === "paused"
              ? "The agent stops first. Then everything it holds goes to your wallet."
              : "Everything it holds goes to your wallet."
          : "Sends this balance to your wallet."}
      </AlertDialog.Description>
      <div className="mt-5">
        {quote && !agent ? (
          <Review quote={quote} />
        ) : (
          <ReceivePicker
            options={options}
            held={agent !== null}
            value={choice}
            onChange={setChoice}
            disabled={busy}
          />
        )}
      </div>
      <p className="mt-4 flex items-center gap-2 text-small text-fg-muted">
        <Eye aria-hidden="true" size={14} strokeWidth={1.75} absoluteStrokeWidth className="shrink-0" />
        The transfer to your wallet is public on NEAR.
      </p>
      <div aria-live="polite">
        {error ? (
          <p role="alert" className="mt-4 rounded-sm bg-loss-soft p-3 text-small text-loss">
            {error}
          </p>
        ) : null}
      </div>
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        {quote && !agent ? (
          <Button variant="soft" disabled={busy} onClick={() => setQuote(null)}>
            Back
          </Button>
        ) : (
          <AlertDialog.Cancel asChild>
            <Button variant="soft" disabled={busy}>
              Cancel
            </Button>
          </AlertDialog.Cancel>
        )}
        <Button variant="primary" aria-busy={busy} onClick={primary.run}>
          {busy ? <LoaderCircle {...SPIN} className="motion-safe:animate-spin" /> : null}
          {primary.label}
        </Button>
      </div>
    </>
  );
}

/** The one claim dialog of the screen: only it re-renders when a row's Claim opens it. */
export function ClaimDialog({ options }: { readonly options: readonly ReceiveOption[] }): ReactElement {
  const store = useClaimsStore(),
    lenis = useLenis(),
    row = useStoreValue(store.selected);
  const open = row !== null;
  // Lenis would keep scrolling the page behind the dialog (Docs/tech-stack.md → Lenis).
  useEffect(() => {
    if (!open || lenis === undefined) {
      return;
    }
    lenis.stop();
    return () => lenis.start();
  }, [open, lenis]);
  const close = () => store.selected.set(null);
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-scrim fixed inset-0 z-40 bg-bg/80" />
        <AlertDialog.Content className="dialog-panel fixed inset-x-gutter top-1/2 z-50 mx-auto flex max-h-[90dvh] max-w-md -translate-y-1/2 flex-col overflow-y-auto rounded-xl bg-surface-2 p-card shadow-float">
          {row ? (
            <>
              <AlertDialog.Title className="truncate font-rounded text-h2 font-bold text-fg-strong">
                {title(row)}
              </AlertDialog.Title>
              <ClaimForm key={row.id} row={row} options={options} close={close} />
            </>
          ) : null}
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
