"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { type FormEvent, type ReactElement, useRef, useState } from "react";
import { PortfolioPanel } from "@/components/portfolio/panel";
import { readTrading } from "@/components/trading/trading-api";
import { Button } from "@/components/ui/button";
import { AgentKeyDialog } from "@/components/wallet/agent-key-dialog";
import { walletTransactionHash } from "@/components/wallet/transaction-hash";
import { budgetTokenAmount } from "@/shared/agent-budget";
import type { AgentResult, AgentSummary } from "@/shared/agents";
import { shortTokenAmount } from "@/shared/money";
import {
  agentFundingStateSchema,
  directNativeFunding,
  type WalletFundingView,
  walletFundingTransaction,
} from "@/shared/wallet-funding";
import { fundingClose, fundingStep } from "./review-api";

function value<T>(result: AgentResult<T>): T {
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value;
}
/** The query key for an agent's funding state, shared with the deploy flow that waits on it. */
export function agentFundingKey(ownerId: string, agentId: string, revision: number): readonly unknown[] {
  return ["agent-funding", ownerId, agentId, revision];
}

export function AgentWalletFunding({
  agent,
  ownerId,
  accountId,
  available,
  framed = true,
}: {
  readonly agent: Pick<AgentSummary, "id" | "revision" | "status">;
  readonly ownerId: string;
  readonly accountId: string;
  /** False when this deployment has no trading workflow, so funds could not be moved or used. */
  readonly available: boolean;
  /** False inside another surface, such as the create dialog, so the panel isn't a card inside a card. */
  readonly framed?: boolean;
}): ReactElement {
  const cache = useQueryClient(),
    key = agentFundingKey(ownerId, agent.id, agent.revision);
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
    // Polls only while funds are moving: a conversion, or a NEAR deposit 1Click is delivering.
    refetchInterval: (q) => {
      const saved = q.state.data?.funding;
      return saved?.state === "converting" ||
        (saved?.state === "deposited" && directNativeFunding(saved.snapshot))
        ? 5000
        : false;
    },
    refetchIntervalInBackground: false,
  });
  async function changed(): Promise<void> {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["agent-funding", ownerId, agent.id] }),
      cache.invalidateQueries({ queryKey: ["agent-allocations", ownerId, agent.id] }),
      cache.invalidateQueries({ queryKey: ["agent-runtime", ownerId, agent.id] }),
    ]);
  }
  async function reopenReview(fundingId: string): Promise<void> {
    value(await fundingClose("decline", { fundingId }));
    request.current = crypto.randomUUID();
    value(
      await fundingStep("review", {
        requestId: request.current,
        agentId: agent.id,
        expectedRevision: agent.revision,
      }),
    );
  }
  const action = useMutation({
    mutationFn: async (
      command: "review" | "deposit" | "continue" | "proof" | "cancel" | "public" | "decline",
    ) => {
      const saved = query.data?.funding;
      if (command === "review") {
        request.current ??= crypto.randomUUID();
        return value(
          await fundingStep("review", {
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
        value(await fundingClose("cancel", { fundingId: saved.id }));
        request.current = null;
        return null;
      }
      if (command === "public") {
        value(await fundingClose("public", { fundingId: saved.id }));
        return null;
      }
      if (command === "decline") {
        await reopenReview(saved.id);
        return null;
      }
      if (command === "continue") {
        return value(await fundingStep("continue", { fundingId: saved.id }));
      }
      if (command === "proof") {
        return value(
          await fundingStep("proof", { fundingId: saved.id, transactionHash: transactionHash.trim() }),
        );
      }
      const [{ walletForAccount }, { walletNotice }] = await Promise.all([
        import("@/components/wallet/near-connector"),
        import("@/components/wallet/notices"),
      ]);
      const wallet = await walletForAccount(accountId, "authorize", () => {});
      if (!wallet.ok) {
        throw new Error(wallet.notice.text);
      }
      // An expired review gets a fresh quote first, so a retry after a cancel needs no extra click.
      let fundingId = saved.id;
      if (saved.expiresAt <= Date.now()) {
        value(await fundingClose("cancel", { fundingId }));
        request.current = crypto.randomUUID();
        fundingId = value(
          await fundingStep("review", {
            requestId: request.current,
            agentId: agent.id,
            expectedRevision: agent.revision,
          }),
        ).id;
      }
      const attempted = value(await fundingStep("begin", { fundingId }));
      const transaction = walletFundingTransaction(attempted.snapshot);
      let reply: unknown;
      try {
        reply = await wallet.value.signAndSendTransaction({
          ...transaction,
          actions: [...transaction.actions],
        });
      } catch (error) {
        const notice = walletNotice(error, "authorize");
        if (notice.tone === "info") {
          // The wallet reports the owner declined: close that request and get a fresh one, so Confirm works again.
          await reopenReview(fundingId);
          throw new Error("Deposit cancelled in your wallet. Confirm again when you’re ready.");
        }
        throw new Error(notice.text);
      }
      const hash = walletTransactionHash.parse(reply);
      setTransactionHash(hash);
      const confirmed = value(await fundingStep("proof", { fundingId, transactionHash: hash }));
      return confirmed.state === "deposited"
        ? value(await fundingStep("continue", { fundingId }))
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
  const content = (
    <>
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
                Allow your agents to trade for you. One approval covers all of them, and you can revoke it in
                Settings.
              </p>
              <AgentKeyDialog accountId={accountId} onAuthorized={changed} />
            </div>
          ) : null}
          {data.budget ? (
            <p className="text-small">
              <span className="text-fg-muted">Budget </span>
              <span
                className="font-mono tabular-nums text-fg-strong"
                title={`${budgetTokenAmount(data.budget.units, data.budget.decimals)} ${data.budget.symbol}`}
              >
                {shortTokenAmount(data.budget.units, data.budget.decimals)} {data.budget.symbol}
              </span>
            </p>
          ) : null}
          {funding ? (
            <FundingProgress funding={funding} busy={busy} onAction={(command) => action.mutate(command)} />
          ) : data.allocatedPrivateUnits !== "0" ? (
            <p className="text-small text-accent-text">Funds are in. Start the agent when you’re ready.</p>
          ) : data.allocatedPublicUnits !== "0" ? (
            <p className="text-small text-fg-muted">
              Funds are in your public Intents balance. Manage them under More details.
            </p>
          ) : data.budget?.walletReservedUnits === "0" ? (
            <p className="text-small text-fg-muted">
              This budget was already moved or released. Manage the rest under More details.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-small text-fg-muted">
                Choosing a budget only set it aside in your wallet. Move it to the agent with one wallet
                approval; the cost is shown before you approve.
              </p>
              <Button
                variant="primary"
                disabled={busy || !available || !data.authorized || agent.status === "running"}
                onClick={() => action.mutate("review")}
              >
                {busy ? "Checking costs…" : "Move funds to agent"}
              </Button>
              {available ? null : (
                <p className="text-caption text-warn">
                  Funding and starting need the trading workflow: use the Vercel app, or set
                  WRENAI_LOCAL_EXECUTION=1 for this copy.
                </p>
              )}
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
              <div className="flex flex-wrap gap-3">
                <Button type="submit" disabled={busy}>
                  {busy ? "Verifying…" : "Verify deposit"}
                </Button>
                {/* For a wallet window that closed without approving. A deposit sent anyway stays in your own balance. */}
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => action.mutate("decline")}
                >
                  I didn’t approve it
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
      {action.error ? (
        <p role="alert" className="mt-3 text-small text-warn">
          {action.error.message}
        </p>
      ) : null}
    </>
  );
  return framed ? (
    <PortfolioPanel id="agent-funding" title="Funds">
      {content}
    </PortfolioPanel>
  ) : (
    content
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
  // Native NEAR is deposited as 1Click's NEAR asset (wrap.near); to the user it is NEAR throughout.
  const symbol = snapshot.walletAssetId === "native:near" ? "NEAR" : snapshot.symbol;
  if (funding.state === "prepared") {
    return (
      <div className="space-y-3">
        <dl className="grid gap-3 text-small sm:grid-cols-2">
          <div>
            <dt className="text-fg-muted">From your wallet</dt>
            <dd className="break-all font-mono tabular-nums">
              {budgetTokenAmount(snapshot.units, snapshot.decimals)} {symbol}
            </dd>
          </div>
          <div>
            <dt className="text-fg-muted">Minimum into your private balance</dt>
            <dd className="break-all font-mono tabular-nums">
              {budgetTokenAmount(snapshot.minimumPrivateUnits, snapshot.decimals)} {symbol}
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
  if (funding.state === "deposited" && directNativeFunding(snapshot)) {
    return (
      <div className="space-y-3">
        <p role="status" className="flex items-center gap-2 text-small text-fg-muted">
          <LoaderCircle
            size={14}
            strokeWidth={1.75}
            absoluteStrokeWidth
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
          NEAR sent. It usually reaches the agent within a minute.
        </p>
        <Button variant="soft" disabled={busy} onClick={() => onAction("continue")}>
          {busy ? "Checking…" : "Check now"}
        </Button>
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
