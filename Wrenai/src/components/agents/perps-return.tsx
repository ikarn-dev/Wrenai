"use client";
import { useMutation } from "@tanstack/react-query";
import { ArrowDownLeft } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmPerpsReturn, previewPerpsReturn } from "@/server/execution/perps-return-actions";
import { formatUnits } from "@/shared/money";
import type { PerpsReturnPreview } from "@/shared/perps-return";

interface PerpsReturnFundsProps {
  readonly agentId: string;
  readonly revision: number;
  readonly running: boolean;
  readonly pending: boolean;
}
function amount(units: string, decimals: number): string {
  return formatUnits(BigInt(units), { decimals, fractionDigits: decimals }).replace(
    /(\.\d*?[1-9])0+$|\.0+$/,
    "$1",
  );
}
function ReturnPreview({ preview }: { readonly preview: PerpsReturnPreview }): ReactElement {
  return (
    <dl className="grid min-w-0 grid-cols-1 gap-3 text-small sm:grid-cols-2">
      <div>
        <dt className="text-fg-muted">From Perps</dt>
        <dd className="font-mono tabular-nums">{amount(preview.debitUnits, 6)} USDC</dd>
      </div>
      <div>
        <dt className="text-fg-muted">Minimum received</dt>
        <dd className="break-all font-mono tabular-nums">
          {amount(preview.receiveUnits, preview.receiveDecimals)} {preview.receiveSymbol}
        </dd>
      </div>
      <div>
        <dt className="text-fg-muted">Transfer fee included</dt>
        <dd className="font-mono tabular-nums">{amount(preview.networkFeeUnits, 6)} USDC</dd>
      </div>
      <div>
        <dt className="text-fg-muted">To your private balance</dt>
        <dd className="break-all font-mono">{preview.destinationAccount}</dd>
      </div>
    </dl>
  );
}
export function PerpsReturnFunds({
  agentId,
  revision,
  running,
  pending,
}: PerpsReturnFundsProps): ReactElement {
  const [open, setOpen] = useState(false);
  const preview = useMutation({
    mutationFn: async () => {
      const result = await previewPerpsReturn({
        agentId,
        expectedRevision: revision,
        requestId: crypto.randomUUID(),
      });
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.value;
    },
  });
  const confirm = useMutation({
    mutationFn: async (saved: PerpsReturnPreview) => {
      const result = await confirmPerpsReturn({ previewId: saved.id, evidenceHash: saved.evidenceHash });
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.value;
    },
  });
  const busy = preview.isPending || confirm.isPending,
    error = confirm.error ?? preview.error;
  const completed = confirm.data?.status === "settled",
    cancelled = confirm.data?.status === "cancelled";
  return (
    <div className="mt-4 flex min-w-0 flex-col gap-4 border-t border-line pt-4">
      {!open ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            disabled={running || pending}
            onClick={() => {
              setOpen(true);
              preview.mutate();
            }}
          >
            <ArrowDownLeft aria-hidden="true" size={16} />
            Return funds
          </Button>
          <p className="text-caption text-fg-subtle">
            {running
              ? "Pause this agent and close its positions first."
              : pending
                ? "Reconcile existing orders first."
                : "Review fees before returning closed-account funds."}
          </p>
        </div>
      ) : (
        <>
          {preview.isPending ? (
            <p role="status" className="text-small text-fg-muted">
              Checking funds and fees…
            </p>
          ) : null}
          {preview.data && !confirm.data ? (
            <>
              <ReturnPreview preview={preview.data} />
              <p className="text-caption text-fg-subtle">
                The minimum received includes route costs and slippage. The venue transfer is public.
                Confirmation rechecks the quote; if it expires, request a new preview.
              </p>
            </>
          ) : null}
          {confirm.data ? (
            <p role="status" className="text-small text-fg-muted">
              {cancelled
                ? "The return was not sent. Request a fresh preview."
                : completed
                  ? "Return recorded. Balances are being refreshed."
                  : confirm.data.tracking
                    ? "Return submitted. You can leave this page while it is tracked."
                    : "The return may be submitted. Use Check orders to reconcile it; do not create another transfer."}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-small text-loss">
              {error.message}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            {preview.data && !confirm.data ? (
              <Button
                variant="primary"
                disabled={busy || running}
                aria-busy={confirm.isPending}
                onClick={() => {
                  if (preview.data) {
                    confirm.mutate(preview.data);
                  }
                }}
              >
                {confirm.isPending ? "Confirming…" : "Confirm return"}
              </Button>
            ) : null}
            {!confirm.data || cancelled ? (
              <Button
                disabled={busy}
                onClick={() => {
                  confirm.reset();
                  preview.mutate();
                }}
              >
                Refresh preview
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                preview.reset();
                confirm.reset();
              }}
            >
              Close
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
