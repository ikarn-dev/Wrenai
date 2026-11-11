"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactElement, useState, useTransition } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  cancelNativeFunding,
  confirmNativeFundingStep,
  declineNativeFundingStep,
  readNativeFunding,
  reviewNativeFunding,
  startNativeFundingStep,
} from "@/server/funding/native-actions";
import { budgetTokenAmount } from "@/shared/agent-budget";
import type { TradingResult } from "@/shared/manual-trading";
import {
  type NativeFundingView,
  nativeDepositTransaction,
  nativeGasTransaction,
} from "@/shared/native-funding";

function value<T>(result: TradingResult<T>): T {
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value;
}
const field = "min-h-11 w-full min-w-0 rounded-sm border border-line-strong bg-sunken px-3 py-2 text-small";
const walletHash = z
  .object({ transaction: z.object({ hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/) }) })
  .transform((r) => r.transaction.hash);

export function NativeFunding({
  accountId,
  ready,
  agent,
}: {
  readonly accountId: string;
  readonly ready: boolean;
  readonly agent?: { readonly id: string; readonly assetId: string; readonly amount: string };
}): ReactElement {
  const cache = useQueryClient(),
    [busy, startTransition] = useTransition(),
    [error, setError] = useState<string | null>(null),
    [hash, setHash] = useState("");
  const query = useQuery({
    queryKey: ["native-funding", accountId],
    queryFn: async () => value(await readNativeFunding()),
    enabled: ready,
    staleTime: 15000,
    retry: false,
  });
  const funding = query.data,
    mine = funding && funding.snapshot.agentId === (agent?.id ?? null) ? funding : null;
  const savedHash = mine?.state === "token_pending" ? mine.tokenHash : null;
  async function changed(view: NativeFundingView | null): Promise<void> {
    cache.setQueryData(["native-funding", accountId], view?.state === "complete" ? null : view);
    await cache.invalidateQueries({ queryKey: ["manual-account", accountId] });
  }
  function review(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(async () => {
      setError(null);
      try {
        await changed(
          value(
            await reviewNativeFunding({
              requestId: crypto.randomUUID(),
              ...(agent ? { agentId: agent.id } : {}),
              assetId: agent?.assetId ?? String(data.get("asset")),
              amount: agent?.amount ?? String(data.get("amount")),
            }),
          ),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "The funding review failed.");
      }
    });
  }
  function continueFunding(proofOnly: boolean): void {
    if (!mine) {
      return;
    }
    const saved = mine,
      role = saved.state === "prepared" || saved.state === "gas_pending" ? "gas" : "token";
    startTransition(async () => {
      setError(null);
      try {
        const command = { id: saved.id, snapshotHash: saved.snapshotHash, role };
        if (proofOnly) {
          await changed(
            value(await confirmNativeFundingStep({ ...command, transactionHash: savedHash ?? hash.trim() })),
          );
          setHash("");
          return;
        }
        const { walletForAccount } = await import("@/components/wallet/near-connector");
        const wallet = await walletForAccount(accountId, "authorize", () => {});
        if (!wallet.ok) {
          setError(wallet.notice.text);
          return;
        }
        const attempted = value(await startNativeFundingStep(command));
        await changed(attempted);
        const transaction =
          role === "gas"
            ? nativeGasTransaction(attempted.snapshot)
            : nativeDepositTransaction(attempted.snapshot);
        let response: unknown;
        try {
          response = await wallet.value.signAndSendTransaction(transaction);
        } catch (failure) {
          const { walletNotice } = await import("@/components/wallet/notices");
          const notice = walletNotice(failure, "authorize");
          if (notice.tone === "info") {
            // Declined in the wallet: reopen this step so it can simply be approved again.
            value(await declineNativeFundingStep({ id: saved.id, snapshotHash: saved.snapshotHash }));
            setError("Deposit cancelled in your wallet. Continue when you’re ready.");
            await query.refetch();
            return;
          }
          throw new Error(notice.text);
        }
        const transactionHash = walletHash.parse(response);
        setHash(transactionHash);
        await changed(value(await confirmNativeFundingStep({ ...command, transactionHash })));
        setHash("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Check this funding step's transaction before continuing.");
        void query.refetch();
        await query.refetch();
      }
    });
  }
  if (!ready) {
    return <p className="text-small text-fg-muted">Save the recovery backup to fund native RHEA trading.</p>;
  }
  return (
    <details className="rounded-md border border-line-card p-4">
      <summary className="cursor-pointer text-small text-accent-text">
        {agent ? "Fund native RHEA execution" : "Add funds for native RHEA swaps"}
      </summary>
      <div className="mt-4 space-y-4">
        <p className="text-small text-fg-muted">
          Fund gas, then transfer tokens in your wallet. Future swaps use the trading account. Native
          transactions are public.
        </p>
        {funding && !mine ? (
          <p className="text-small text-warn">
            Finish the existing native funding request before creating another.
          </p>
        ) : mine ? (
          <>
            <dl className="space-y-2 text-small">
              <div className="flex justify-between gap-4">
                <dt>Token allocation</dt>
                <dd className="font-mono tabular-nums">
                  {budgetTokenAmount(mine.snapshot.units, mine.snapshot.decimals)} {mine.snapshot.tokenSymbol}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Gas balance top-up</dt>
                <dd className="font-mono tabular-nums">0.1 NEAR</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Token registration, up to</dt>
                <dd className="font-mono tabular-nums">
                  {budgetTokenAmount(mine.snapshot.registrationUnits, 24)} NEAR
                </dd>
              </div>
            </dl>
            {mine.state === "gas_pending" || mine.state === "token_pending" ? (
              <div className="space-y-3">
                <p className="text-small text-warn">
                  Verify the {mine.state === "gas_pending" ? "gas" : "token"} transaction before sending
                  again.
                </p>
                <label className="flex flex-col gap-2 text-small text-fg-muted">
                  Transaction hash
                  <input
                    value={savedHash ?? hash}
                    readOnly={savedHash !== null}
                    onChange={(e) => setHash(e.target.value)}
                    autoComplete="off"
                    className={field}
                  />
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => continueFunding(true)}
                  disabled={busy || !(savedHash ?? hash.trim())}
                >
                  {busy ? "Checking…" : "Verify transaction"}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-3">
                <Button type="button" disabled={busy} onClick={() => continueFunding(false)}>
                  {busy
                    ? "Check your wallet…"
                    : mine.state === "prepared"
                      ? "Fund gas · 0.1 NEAR"
                      : "Transfer tokens"}
                </Button>
                {mine.state === "prepared" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      startTransition(async () => {
                        const r = await cancelNativeFunding({ id: mine.id, snapshotHash: mine.snapshotHash });
                        if (r.ok) {
                          await changed(null);
                        } else {
                          setError(r.message);
                        }
                      });
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            )}
          </>
        ) : (
          <form onSubmit={review} className="space-y-3" aria-busy={busy}>
            {agent ? (
              <p className="text-small text-fg-muted">
                Moves the agent's exact remaining wallet allocation to its native balance.
              </p>
            ) : (
              <>
                <label className="flex flex-col gap-2 text-small text-fg-muted">
                  Wallet token
                  <input
                    name="asset"
                    defaultValue="native:near"
                    placeholder="native:near or nep141:token.near"
                    required
                    className={field}
                  />
                </label>
                <label className="flex flex-col gap-2 text-small text-fg-muted">
                  Amount
                  <input
                    name="amount"
                    inputMode="decimal"
                    required
                    placeholder="0.00"
                    className={`${field} font-mono tabular-nums`}
                  />
                </label>
              </>
            )}
            <Button type="submit" variant="secondary" disabled={busy}>
              {busy ? "Checking balance…" : "Review funding"}
            </Button>
          </form>
        )}
        {error || query.error ? (
          <p role="alert" className="text-small text-warn">
            {error ?? query.error?.message}
          </p>
        ) : null}
      </div>
    </details>
  );
}
