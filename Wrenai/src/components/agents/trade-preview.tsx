"use client";
import { base64urlnopad } from "@scure/base";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, type ReactElement, useRef, useState, useTransition } from "react";
import { PortfolioPanel } from "@/components/portfolio/panel";
import { Button } from "@/components/ui/button";
import { walletForAccount } from "@/components/wallet/near-connector";
import { attempt, walletNotice } from "@/components/wallet/notices";
import {
  connectPrivateBalance,
  loadAgentTradeAssets,
  previewAgentTrade,
  requestPrivateBalanceConnection,
  saveAgentTradeAssets,
} from "@/server/execution/preview-actions";
import type { AgentSummary } from "@/shared/agents";
import { parseTokenAmount } from "@/shared/token-units";
import type { AgentTradeAssets, TradeAsset, TradePreview } from "@/shared/trade-preview";
import { AgentFunding } from "./funding";
import { TradePreviewResult } from "./trade-preview-result";

const field =
  "min-h-11 w-full min-w-0 rounded-sm border border-line bg-surface-2 px-3 text-small text-fg-strong disabled:cursor-not-allowed disabled:text-fg-disabled";

function AssetReview({
  assets,
  onReviewed,
}: {
  readonly assets: AgentTradeAssets;
  readonly onReviewed: (assets: readonly TradeAsset[]) => void;
}): ReactElement {
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(async () => {
      setError(null);
      try {
        const result = await saveAgentTradeAssets({
          agentId: assets.agentId,
          expectedRevision: assets.revision,
          requestId: crypto.randomUUID(),
          assets: assets.choices.map((choice) => ({
            symbol: choice.symbol,
            assetId: String(data.get(choice.symbol) ?? ""),
          })),
        });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        onReviewed(result.value);
      } catch {
        setError("Assets could not be reviewed. Refresh and try again.");
      }
    });
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-small leading-relaxed text-fg-muted">
        Confirm the exact token behind each strategy symbol. Matching symbols can represent different assets.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {assets.choices.map((choice) => (
          <label key={choice.symbol} className="flex min-w-0 flex-col gap-2 text-small">
            <span>{choice.symbol}</span>
            <select name={choice.symbol} required disabled={busy} className={field} defaultValue="">
              <option value="">Choose exact asset</option>
              {choice.candidates.map((asset) => (
                <option key={asset.assetId} value={asset.assetId}>
                  {asset.tokenSymbol} · {asset.blockchain} · {asset.contractAddress ?? asset.assetId}
                </option>
              ))}
            </select>
            {choice.candidates.length === 0 ? (
              <span className="text-caption text-warn">No supported asset matches this symbol.</span>
            ) : null}
          </label>
        ))}
      </div>
      <Button
        type="submit"
        disabled={busy || assets.choices.some((choice) => choice.candidates.length === 0)}
      >
        {busy ? "Saving…" : "Confirm assets"}
      </Button>
      {error ? (
        <p role="alert" className="text-small text-warn">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function QuoteForm({
  agent,
  assets,
  accountId,
}: {
  readonly agent: AgentSummary;
  readonly assets: readonly TradeAsset[];
  readonly accountId: string;
}): ReactElement {
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TradePreview | null>(null);
  const attemptId = useRef<{ readonly hash: string; readonly id: string } | null>(null);
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const origin = assets.find((asset) => asset.assetId === data.get("input"));
    try {
      if (!origin) {
        throw new RangeError("Choose the input asset.");
      }
      const input = {
        agentId: agent.id,
        expectedRevision: agent.revision,
        inputAssetId: origin.assetId,
        outputAssetId: String(data.get("output") ?? ""),
        inputUnits: parseTokenAmount(String(data.get("amount") ?? ""), origin.decimals).toString(),
        slippageBps: agent.policy.maxSlippageBps,
      };
      const hash = JSON.stringify(input);
      if (attemptId.current?.hash !== hash) {
        attemptId.current = { hash, id: crypto.randomUUID() };
      }
      const requestId = attemptId.current.id;
      startTransition(async () => {
        setError(null);
        try {
          const result = await previewAgentTrade({ ...input, requestId });
          if (!result.ok) {
            setError(result.message);
            return;
          }
          attemptId.current = null;
          setPreview(result.value);
        } catch {
          setError("The preview could not be confirmed. Retry to recover this request.");
        }
      });
    } catch (error) {
      setError(
        error instanceof RangeError ? error.message : "Enter a valid amount within this token's precision.",
      );
    }
  }
  async function connectBalance(): Promise<void> {
    setError(null);
    try {
      const wallet = await walletForAccount(accountId, "authorize", () => {});
      if (!wallet.ok) {
        setError(wallet.notice.text);
        return;
      }
      const challenge = await requestPrivateBalanceConnection();
      if (!challenge.ok) {
        setError(challenge.message);
        return;
      }
      const value = challenge.value;
      const signed = await attempt(
        () =>
          wallet.value.signMessage({
            message: value.message,
            recipient: value.recipient,
            nonce: base64urlnopad.decode(value.nonce),
          }),
        (error) => walletNotice(error, "authorize"),
      );
      if (!signed.ok) {
        setError(signed.notice.text);
        return;
      }
      const result = await connectPrivateBalance({
        accountId: signed.value.accountId,
        publicKey: signed.value.publicKey,
        signature: signed.value.signature,
        nonce: value.nonce,
      });
      if (!result.ok) {
        setError(result.message);
      } else {
        setPreview(null);
      }
    } catch {
      setError("The private balance connection could not be completed. Try again.");
    }
  }
  return (
    <div className="space-y-5">
      <form onSubmit={submit} onChange={() => setPreview(null)} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {(["input", "output"] as const).map((name) => (
            <label key={name} className="flex min-w-0 flex-col gap-2 text-small">
              <span>{name === "input" ? "Pay with" : "Receive"}</span>
              <select name={name} required disabled={busy} className={field} defaultValue="">
                <option value="">Choose token</option>
                {assets.map((asset) => (
                  <option key={asset.assetId} value={asset.assetId}>
                    {asset.tokenSymbol} · {asset.blockchain}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <label className="flex flex-col gap-2 text-small">
          <span>Input token amount</span>
          <input
            name="amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            required
            maxLength={115}
            disabled={busy}
            className={field}
            placeholder="0.00"
          />
        </label>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? "Checking…" : "Preview trade"}
          </Button>
          <Button type="button" disabled={busy} onClick={() => startTransition(connectBalance)}>
            Connect private balance
          </Button>
        </div>
        <p className="text-caption text-fg-subtle">
          Balance connection uses a read-only wallet signature. It does not authorize a trade or move funds.
        </p>
      </form>
      {error ? (
        <p role="alert" className="text-small text-warn">
          {error}
        </p>
      ) : null}
      {preview ? <TradePreviewResult key={preview.id} preview={preview} /> : null}
      {preview ? <AgentFunding key={`funding:${preview.id}`} agent={agent} preview={preview} /> : null}
    </div>
  );
}

export function AgentTradePreview({
  agent,
  accountId,
}: {
  readonly agent: AgentSummary;
  readonly accountId: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [reviewed, setReviewed] = useState<readonly TradeAsset[] | null>(null);
  const query = useQuery({
    queryKey: ["agent-trade-assets", agent.id, agent.revision],
    enabled: open,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const result = await loadAgentTradeAssets({ agentId: agent.id, expectedRevision: agent.revision });
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.value;
    },
  });
  const assets = reviewed ?? query.data?.reviewed ?? [];
  return (
    <PortfolioPanel
      id="trade-preview"
      title="Trade preview"
      aside={<Button onClick={() => setOpen((value) => !value)}>{open ? "Hide" : "Review trade"}</Button>}
    >
      {open ? (
        query.isLoading ? (
          <p role="status" className="text-small text-fg-subtle">
            Loading exact assets…
          </p>
        ) : query.error ? (
          <div className="space-y-3">
            <p role="alert" className="text-small text-warn">
              {query.error.message}
            </p>
            <Button onClick={() => void query.refetch()}>Try again</Button>
          </div>
        ) : query.data ? (
          assets.length ? (
            <QuoteForm agent={agent} assets={assets} accountId={accountId} />
          ) : (
            <AssetReview assets={query.data} onReviewed={setReviewed} />
          )
        ) : null
      ) : (
        <p className="text-small text-fg-muted">
          Review exact assets, current quotes, available funds and trading limits before execution.
        </p>
      )}
    </PortfolioPanel>
  );
}
