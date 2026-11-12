"use client";
import type { ReactElement } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { PaymentSummary } from "@/components/chat/payment-card-parts";
import { QuoteTimer, SwapSummary } from "@/components/trading/swap-summary";
import { Button } from "@/components/ui/button";
import { nearConnector } from "@/components/wallet/near-connector";
import { walletTransactionHash } from "@/components/wallet/transaction-hash";
import { type TestnetSnapshot, testnetAsset, tokenText } from "@/shared/testnet";
import { testnetApi } from "./api";

type Order = TestnetSnapshot["orders"][number];
export function TestnetOrderCard({
  order,
  owner,
  onChanged,
}: {
  readonly order: Order;
  readonly owner: TestnetSnapshot["owner"];
  readonly onChanged: () => Promise<unknown>;
}): ReactElement | null {
  const [busy, setBusy] = useState(false),
    [hash, setHash] = useState("");
  async function run(action: "confirm" | "receipt" | "wallet" | "resume"): Promise<void> {
    setBusy(true);
    try {
      if (action === "wallet") {
        const call = order.calls?.[0];
        if (!call || !owner.accountId) {
          throw new Error("Refresh this wallet order before approving.");
        }
        const connector = await nearConnector("testnet"),
          wallet = await connector.wallet();
        const accounts = await wallet.getAccounts();
        if (!accounts.some((a) => a.accountId === owner.accountId)) {
          throw new Error("Connect the wallet that reviewed this order.");
        }
        const actions =
          call.method === null
            ? [{ type: "Transfer" as const, params: { deposit: call.deposit } }]
            : [
                {
                  type: "FunctionCall" as const,
                  params: { methodName: call.method, args: call.args, gas: call.gas, deposit: call.deposit },
                },
              ];
        const reply = await wallet.signAndSendTransaction({
          signerId: owner.accountId,
          receiverId: call.receiverId,
          actions,
        });
        const tx = walletTransactionHash.parse(reply);
        setHash(tx);
        await testnetApi({ command: "receipt", id: order.id, hash: tx });
        toast.success("Transaction submitted.");
      } else {
        await testnetApi({ command: action, id: order.id, ...(action === "receipt" ? { hash } : {}) });
        toast.info(action === "confirm" ? "Order confirmed." : "Receipt saved.");
      }
      await onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The transaction needs a status check.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flex w-full max-w-sm flex-col gap-3 card-shine rounded-lg p-3.5">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-small font-medium text-fg-strong">
          {order.kind === "payment" ? "Public payment" : "Testnet swap"}
        </h3>
        {order.state === "review" ? (
          <QuoteTimer expiresAt={order.expiresAt} />
        ) : (
          <span className="text-caption text-fg-muted">{order.state.replaceAll("_", " ")}</span>
        )}
      </div>
      <p className="text-small text-fg-muted">
        {order.location === "intents" ? "Public Intents" : "Wallet"} →{" "}
        {order.kind === "payment"
          ? order.location === "intents"
            ? "Recipient’s public Intents"
            : "Recipient’s wallet"
          : order.outputLocation === "intents"
            ? "Public Intents"
            : "Wallet"}
      </p>
      {order.outputAssetId ? (
        <SwapSummary
          input={{
            decimals: testnetAsset(order.assetId).decimals,
            tokenSymbol: testnetAsset(order.assetId).symbol,
          }}
          output={{
            decimals: testnetAsset(order.outputAssetId).decimals,
            tokenSymbol: testnetAsset(order.outputAssetId).symbol,
          }}
          inputUnits={order.inputUnits}
          outputUnits={order.quotedOutputUnits}
          minimumOutputUnits={order.minimumOutputUnits}
          settled={
            order.state === "settled" && order.outputUnits
              ? { spentUnits: order.inputUnits, receivedUnits: order.outputUnits }
              : undefined
          }
        />
      ) : (
        <PaymentSummary
          offer={{
            id: order.id,
            recipient: order.recipient,
            assetId: order.assetId,
            symbol: testnetAsset(order.assetId).symbol,
            amount: tokenText(order.inputUnits, testnetAsset(order.assetId).decimals),
            routes: ["wallet"],
          }}
          wallet={null}
          topUp={null}
        />
      )}
      {order.message ? (
        <p className="text-small text-fg-muted" role="status">
          {order.message}
        </p>
      ) : null}
      {order.state === "review" ? (
        <Button
          disabled={busy || order.expiresAt <= Date.now()}
          aria-busy={busy}
          onClick={() => {
            void run("confirm");
          }}
        >
          Confirm {order.kind === "payment" ? "payment" : "swap"}
        </Button>
      ) : order.calls?.length ? (
        <Button
          disabled={busy}
          onClick={() => {
            void run("wallet");
          }}
        >
          Approve next wallet step
        </Button>
      ) : null}
      {order.txHash && !["settled", "failed"].includes(order.state) ? (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            void run("resume");
          }}
        >
          Check status
        </Button>
      ) : null}
      {order.txHash ? (
        <a
          className="text-small text-accent-text"
          href={`https://testnet.nearblocks.io/txns/${encodeURIComponent(order.txHash)}`}
          target="_blank"
          rel="noreferrer"
        >
          View transaction
        </a>
      ) : null}
      {owner.kind === "wallet" && !order.txHash && order.state !== "review" && order.state !== "settled" ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run("receipt");
          }}
        >
          <label className="flex-1 text-small">
            Recover by transaction hash
            <input
              className="mt-1 w-full rounded-inset bg-sunken p-3"
              value={hash}
              onChange={(e) => setHash(e.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <Button type="submit" variant="secondary" disabled={busy || !hash}>
            Check receipt
          </Button>
        </form>
      ) : null}
      <p className="text-small font-mono tabular-nums text-fg-muted">
        Network fee cap {tokenText(order.maxNetworkUnits, 24)} NEAR · Attached deposits{" "}
        {tokenText(order.registrationUnits, 24)} NEAR
      </p>
      <p className="text-small text-fg-subtle">
        Test funds · public settlement · fees and storage may use native NEAR.
      </p>
    </section>
  );
}
