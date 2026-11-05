"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactElement, useRef, useState } from "react";
import { PortfolioPanel } from "@/components/portfolio/panel";
import { readTrading } from "@/components/trading/trading-api";
import { Button } from "@/components/ui/button";
import { AgentKeyDialog } from "@/components/wallet/agent-key-dialog";
import { walletTransactionHash } from "@/components/wallet/transaction-hash";
import {
  beginWalletFunding,
  cancelWalletFundingReview,
  continueWalletFunding,
  reviewWalletFunding,
  stopPrivateFunding,
  submitWalletFundingProof,
} from "@/server/funding/actions";
import { budgetTokenAmount } from "@/shared/agent-budget";
import type { AgentResult, AgentSummary } from "@/shared/agents";
import {
  agentFundingStateSchema,
  type WalletFundingView,
  walletFundingTransaction,
} from "@/shared/wallet-funding";

function value<T>(result: AgentResult<T>): T {
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value;
}
export function AgentWalletFunding({
  agent,
  ownerId,
  accountId,
}: {
  readonly agent: AgentSummary;
  readonly ownerId: string;
  readonly accountId: string;
}): ReactElement {
  const cache = useQueryClient(),
    key = ["agent-funding", ownerId, agent.id, agent.revision];
  const request = useRef<string | null>(null);
  const [transactionHash, setTransactionHash] = useState("");
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      readTrading(
        `/api/agents/${encodeURIComponent(agent.id)}?view=funding`,
        agentFundingStateSchema,
        signal,
      ),
    retry: false,
    staleTime: 5000,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data?.funding?.state === "converting" ? 5000 : false),
    refetchIntervalInBackground: false,
  });
  async function changed(): Promise<void> {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["agent-funding", ownerId, agent.id] }),
      cache.invalidateQueries({ queryKey: ["agent-allocations", ownerId, agent.id] }),
      cache.invalidateQueries({ queryKey: ["agent-runtime", ownerId, agent.id] }),
    ]);
  }
  const action = useMutation({
    mutationFn: async (command: "review" | "deposit" | "continue" | "proof" | "cancel" | "public") => {
      const saved = query.data?.funding;
      if (command === "review") {
        request.current ??= crypto.randomUUID();
        return value(
          await reviewWalletFunding({
            requestId: request.current,
            agentId: agent.id,
            expectedRevision: agent.revision,
          }),
        );
      }
      if (!saved) {
        throw new Error("Refresh the agent funding review.");
      }
      if (command === "cancel") {
        value(await cancelWalletFundingReview({ fundingId: saved.id }));
        request.current = null;
        return null;
      }
      if (command === "public") {
        value(await stopPrivateFunding({ fundingId: saved.id }));
        return null;
      }
      if (command === "continue") {
        return value(await continueWalletFunding({ fundingId: saved.id }));
      }
      if (command === "proof") {
        return value(
          await submitWalletFundingProof({ fundingId: saved.id, transactionHash: transactionHash.trim() }),
        );
      }
      const { walletForAccount } = await import("@/components/wallet/near-connector");
      const wallet = await walletForAccount(accountId, "authorize", () => {});
      if (!wallet.ok) {
        throw new Error(wallet.notice.text);
      }
      const attempted = value(await beginWalletFunding({ fundingId: saved.id }));
      const transaction = walletFundingTransaction(attempted.snapshot);
      const reply = await wallet.value.signAndSendTransaction({
        ...transaction,
        actions: [...transaction.actions],
      });
      const hash = walletTransactionHash.parse(reply);
      setTransactionHash(hash);
      const confirmed = value(await submitWalletFundingProof({ fundingId: saved.id, transactionHash: hash }));
      return confirmed.state === "deposited"
        ? value(await continueWalletFunding({ fundingId: saved.id }))
        : confirmed;
    },
    onSettled: changed,
  });
  const data = query.data,
    funding = data?.funding,
    busy = action.isPending;
  function proof(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    action.mutate("proof");
  }
  return (
    <PortfolioPanel id="agent-funding" title="Agent funds">
      {query.isPending ? (
        <p role="status" className="text-small text-fg-muted">
          Checking your agent’s funds…
        </p>
      ) : query.error ? (
        <div className="space-y-3">
          <p role="alert" className="text-small text-warn">
            {query.error.message}
          </p>
          <Button onClick={() => void query.refetch()}>Try again</Button>
        </div>
      ) : data ? (
        <div className="space-y-4">
          {!data.authorized ? (
            <div className="space-y-3">
              <p className="text-small text-fg-muted">
                Approve trading once. Your agents share this authorization until you revoke it.
              </p>
              <AgentKeyDialog accountId={accountId} onAuthorized={changed} />
            </div>
          ) : null}
          {data.budget ? (
            <p className="text-small">
              <span className="text-fg-muted">Budget </span>
              <span className="break-all font-mono tabular-nums">
                {budgetTokenAmount(data.budget.units, data.budget.decimals)} {data.budget.symbol}
              </span>
            </p>
          ) : null}
          {funding ? (
            <FundingProgress funding={funding} busy={busy} onAction={(command) => action.mutate(command)} />
          ) : data.allocatedPrivateUnits !== "0" ? (
            <p className="text-small text-accent-text">Funds allocated. Start the agent when you’re ready.</p>
          ) : data.allocatedPublicUnits !== "0" ? (
            <p className="text-small text-fg-muted">
              Funds remain in your public Intents balance. Manage or release their allocation under Advanced
              options.
            </p>
          ) : data.budget?.walletReservedUnits === "0" ? (
            <p className="text-small text-fg-muted">
              This wallet budget has already been used or released. Manage remaining allocations under
              Advanced options.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-small text-fg-muted">
                Review the costs, then confirm one wallet deposit. The private-balance step is handled for
                you.
              </p>
              <Button
                variant="primary"
                disabled={busy || !data.authorized || agent.status === "running"}
                onClick={() => action.mutate("review")}
              >
                {busy ? "Checking costs…" : "Fund agent"}
              </Button>
            </div>
          )}
          {funding?.state === "wallet_pending" ? (
            <form onSubmit={proof} className="space-y-3">
              <p className="text-caption text-fg-muted">
                If you already approved the deposit, paste its transaction hash. A second deposit is not
                required.
              </p>
              <label className="flex flex-col gap-2 text-small">
                Transaction hash
                <input
                  value={transactionHash}
                  onChange={(event) => setTransactionHash(event.target.value)}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-11 rounded-sm border border-line bg-surface-2 px-3 font-mono text-small"
                />
              </label>
              <Button type="submit" disabled={busy}>
                {busy ? "Verifying…" : "Verify deposit"}
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
      {action.error ? (
        <p role="alert" className="mt-3 text-small text-warn">
          {action.error.message}
        </p>
      ) : null}
    </PortfolioPanel>
  );
}
function FundingProgress({
  funding,
  busy,
  onAction,
}: {
  readonly funding: WalletFundingView;
  readonly busy: boolean;
  readonly onAction: (command: "deposit" | "continue" | "cancel" | "public") => void;
}): ReactElement {
  const snapshot = funding.snapshot;
  if (funding.state === "prepared") {
    return (
      <div className="space-y-3">
        <dl className="grid gap-3 text-small sm:grid-cols-2">
          <div>
            <dt className="text-fg-muted">From your wallet</dt>
            <dd className="break-all font-mono tabular-nums">
              {budgetTokenAmount(snapshot.units, snapshot.decimals)} {snapshot.symbol}
            </dd>
          </div>
          <div>
            <dt className="text-fg-muted">Minimum into your private balance</dt>
            <dd className="break-all font-mono tabular-nums">
              {budgetTokenAmount(snapshot.minimumPrivateUnits, snapshot.decimals)} {snapshot.symbol}
            </dd>
          </div>
        </dl>
        <p className="text-caption text-fg-subtle">
          The wallet deposit is public. Network gas is additional. Subsequent private-balance transfers use
          your shared authorization.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" disabled={busy} onClick={() => onAction("deposit")}>
            {busy ? "Confirming…" : "Confirm funding"}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => onAction("cancel")}>
            Cancel review
          </Button>
        </div>
      </div>
    );
  }
  if (funding.state === "deposited" || funding.state === "converting") {
    return (
      <div className="space-y-3">
        <p role="status" className="text-small text-fg-muted">
          {funding.state === "deposited"
            ? "Wallet deposit confirmed. Finish moving these funds into your private balance."
            : "Funding is being tracked. You can leave this page."}
        </p>
        <div className="flex flex-wrap gap-3">
          <Button disabled={busy} onClick={() => onAction("continue")}>
            {busy ? "Checking…" : funding.state === "deposited" ? "Finish funding" : "Check funding"}
          </Button>
          {funding.state === "deposited" ? (
            <Button variant="ghost" disabled={busy} onClick={() => onAction("public")}>
              Keep funds public
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <p role="status" className="text-small text-fg-muted">
      {funding.state === "complete" ? "Funding complete." : "Waiting for the wallet deposit to be confirmed."}
    </p>
  );
}
