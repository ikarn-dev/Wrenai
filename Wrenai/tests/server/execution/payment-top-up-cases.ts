import { expect, type Mock, vi } from "vitest";
import { z } from "zod";
import type { AppDatabase } from "@/server/db/client";
import { privateTokenId } from "@/server/execution/confidential-intents";
import { advanceManualTrade } from "@/server/manual-trading/advance";
import { reviewJarvisPrivatePayment } from "@/server/manual-trading/payment-top-up";
import { readManualPreview } from "@/server/manual-trading/service";
import { readFinalTransaction } from "@/server/near/rpc";
import { unreservedOwnedUnits } from "@/server/positions/lots";
import { readPaymentTopUp } from "@/server/wallet-swap/private-top-up";
import { beginWalletSwap } from "@/server/wallet-swap/service";
import { walletSwapTransaction } from "@/shared/wallet-swap";

const quoteResponse = z.looseObject({ quote: z.looseObject({}) });
const route = z.object({ depositType: z.string() });
const generatedIntent = z.looseObject({
  intent: z.looseObject({ payload: z.looseObject({ message: z.string() }) }),
});
const intentMessage = z.looseObject({
  intents: z.tuple([z.looseObject({ tokens: z.record(z.string(), z.string()) })]),
});

export async function exercisePaymentTopUp(
  context: { db: AppDatabase; agentId: string },
  asset: string,
  provider: {
    request: Mock<(path: string, body: unknown) => Promise<unknown>>;
    status: Mock<(depositAddress: string | null) => unknown>;
  },
  setBalance: (balance: string) => void,
  settlePayment: () => void,
  {
    startBalance,
    shortfall,
    freshDebit,
    expected,
  }: {
    startBalance: string;
    shortfall: string;
    freshDebit: string;
    expected: string;
  },
): Promise<void> {
  setBalance(startBalance);
  const id = crypto.randomUUID();
  const original = provider.request.getMockImplementation();
  const originalStatus = provider.status.getMockImplementation();
  const walletDeposit = "b".repeat(64);
  let walletQuote: unknown;
  let credited = false;
  provider.request.mockImplementation(async (path, body) => {
    const value = await original?.(path, body);
    if (path === "/v0/quote" && route.parse(body).depositType === "ORIGIN_CHAIN") {
      const quote = quoteResponse.parse(value);
      walletQuote = {
        ...quote,
        quote: {
          ...quote.quote,
          depositAddress: walletDeposit,
          amountIn: shortfall,
          amountOut: shortfall,
          minAmountIn: shortfall,
          minAmountOut: shortfall,
        },
      };
      return walletQuote;
    }
    if (path === "/v0/quote" && credited) {
      const quote = quoteResponse.parse(value);
      return { ...quote, quote: { ...quote.quote, amountIn: freshDebit, minAmountIn: freshDebit } };
    }
    if (path === "/v0/generate-intent" && credited && freshDebit !== "1000000") {
      const generated = generatedIntent.parse(value);
      const message = intentMessage.parse(JSON.parse(generated.intent.payload.message));
      message.intents[0].tokens[privateTokenId(asset)] = freshDebit;
      generated.intent.payload.message = JSON.stringify(message);
      return generated;
    }
    return value;
  });
  const review = await reviewJarvisPrivatePayment(context.db, "owner", {
    requestId: id,
    intent: {
      kind: "payment",
      assetId: asset,
      amount: "1",
      recipient: "recipient.near",
      slippageBps: 50,
      maximumFeeBps: 20,
    },
  });
  expect(review.private).toBeNull();
  expect(review.topUp?.quote).toMatchObject({
    inputUnits: shortfall,
    outputUnits: shortfall,
    privateTopUp: { maximumDebitUnits: "1000000" },
  });
  expect(walletQuote).toMatchObject({
    quoteRequest: { recipient: "owner.near", refundTo: "owner.near", recipientType: "CONFIDENTIAL_INTENTS" },
  });
  await expect(beginWalletSwap(context.db, "owner", { id })).rejects.toThrow("original card");
  await expect(advanceManualTrade(context.db, "owner", id)).resolves.toBe(true);
  const started = await beginWalletSwap(context.db, "owner", { id }, true);
  const hash = "2".repeat(44);
  const tx = walletSwapTransaction(started.quote);
  vi.mocked(readFinalTransaction).mockResolvedValue({
    final_execution_status: "FINAL",
    transaction: {
      hash,
      signer_id: tx.signerId,
      receiver_id: tx.receiverId,
      actions: tx.actions.map((action) =>
        action.type === "FunctionCall"
          ? {
              FunctionCall: {
                method_name: action.params.methodName,
                deposit: action.params.deposit,
                gas: action.params.gas,
                args: Buffer.from(JSON.stringify(action.params.args)).toString("base64"),
              },
            }
          : { Transfer: { deposit: action.params.deposit } },
      ),
    },
    status: { SuccessValue: "" },
  });
  const terminal = (amountOut: string) => ({
    quoteResponse: walletQuote,
    status: "SUCCESS",
    updatedAt: new Date().toISOString(),
    swapDetails: {
      originChainTxHashes: [{ hash }],
      amountIn: shortfall,
      amountOut,
      depositedAmount: shortfall,
      refundedAmount: "0",
      intentHashes: ["funding"],
    },
  });
  provider.status.mockImplementation((address) =>
    address === walletDeposit ? terminal(credited ? shortfall : "1") : originalStatus?.(address),
  );
  await expect(advanceManualTrade(context.db, "owner", id)).resolves.toBe(true);
  expect((await readPaymentTopUp(context.db, "owner", id))?.state).toBe("submitted");
  await expect(readManualPreview(context.db, "owner", id)).rejects.toMatchObject({ code: "not_found" });

  credited = true;
  setBalance("21000000");
  await expect(advanceManualTrade(context.db, "owner", id)).resolves.toBe(expected === "confirmed");
  if (expected === "done") {
    expect((await readPaymentTopUp(context.db, "owner", id))?.quote.privateTopUp.reviewRequired).toBe(true);
    await expect(readManualPreview(context.db, "owner", id)).rejects.toMatchObject({ code: "not_found" });
    return;
  }
  const approved = await readManualPreview(context.db, "owner", id);
  if (!approved.actionId) {
    throw new Error("Missing funded payment");
  }
  await advanceManualTrade(context.db, "owner", id);
  expect((await readManualPreview(context.db, "owner", id)).actionId).toBe(approved.actionId);
  settlePayment();
  setBalance("20000000");
  await expect(advanceManualTrade(context.db, "owner", id)).resolves.toBe(false);
  expect(await readManualPreview(context.db, "owner", id)).toMatchObject({
    status: "settled",
    execution: { receivedUnits: "1000000" },
  });
  expect(await unreservedOwnedUnits(context.db, "owner", context.agentId, "confidential", asset)).toBe(
    20000000n,
  );
}
