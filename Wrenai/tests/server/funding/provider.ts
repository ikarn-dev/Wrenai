import { fundingAsset } from "@tests/server/funding/context";
import { z } from "zod";
import { type WalletFundingSnapshot, walletFundingTransaction } from "@/shared/wallet-funding";

/** Offline provider model. Every unrecognized external call fails. */
export class OfflineFundingProvider {
  publicUnits = "0";
  privateUnits = "0";
  submissions = 0;
  loseAcknowledgement = false;
  wrongGeneratedOwner = false;
  terminal = false;
  quoteCount = 0;
  rawQuote: unknown = null;
  snapshot: WalletFundingSnapshot | null = null;
  readonly hash = "1".repeat(44);
  async request(path: string, body: unknown): Promise<unknown> {
    if (path === "/v0/quote") {
      this.quoteCount += 1;
      const request = z.object({ amount: z.string() }).parse(body),
        deadline = new Date(Date.now() + 86400000).toISOString();
      this.rawQuote = {
        correlationId: "offline-funding",
        timestamp: new Date().toISOString(),
        signature: "offline-quote",
        quoteRequest: body,
        quote: {
          amountIn: request.amount,
          minAmountIn: request.amount,
          amountOut: "4990000",
          minAmountOut: "4980000",
          amountInFormatted: "5",
          amountOutFormatted: "4.99",
          amountInUsd: "5",
          amountOutUsd: "4.99",
          timeEstimate: 1,
          depositAddress: this.quoteCount.toString(16).padStart(64, "a"),
          deadline,
        },
      };
      return this.rawQuote;
    }
    if (path === "/v0/generate-intent") {
      const request = z.object({ depositAddress: z.string() }).parse(body),
        quote = z.object({ quote: z.object({ deadline: z.string() }) }).parse(this.rawQuote);
      return {
        correlationId: "offline-payload",
        intent: {
          standard: "nep413",
          payload: {
            recipient: "intents.near",
            nonce: Buffer.alloc(32, 17).toString("base64"),
            message: JSON.stringify({
              signer_id: this.wrongGeneratedOwner ? "stranger.near" : "owner.near",
              deadline: quote.quote.deadline,
              intents: [
                {
                  intent: "transfer",
                  receiver_id: request.depositAddress,
                  tokens: { [fundingAsset]: "5000000" },
                },
              ],
            }),
          },
        },
      };
    }
    if (path === "/v0/submit-intent") {
      this.submissions += 1;
      this.publicUnits = "0";
      if (this.loseAcknowledgement) {
        throw new Error("Offline acknowledgement lost after transfer");
      }
      return { intentHash: this.hash, correlationId: "offline-transfer" };
    }
    throw new Error(`Unexpected offline request ${path}`);
  }
  transaction(): unknown {
    if (!this.snapshot) {
      throw new Error("No reviewed deposit snapshot");
    }
    const transaction = walletFundingTransaction(this.snapshot);
    this.publicUnits = this.snapshot.units;
    return {
      final_execution_status: "FINAL",
      status: { SuccessValue: Buffer.from(JSON.stringify(this.snapshot.units)).toString("base64") },
      transaction: {
        hash: this.hash,
        signer_id: transaction.signerId,
        receiver_id: transaction.receiverId,
        actions: transaction.actions.map(({ params }) => ({
          FunctionCall: {
            method_name: params.methodName,
            args: Buffer.from(JSON.stringify(params.args)).toString("base64"),
            deposit: params.deposit,
            gas: params.gas,
          },
        })),
      },
    };
  }
  status(url: string | URL): Response {
    if (!String(url).startsWith("https://1click.chaindefuser.com/v0/status?")) {
      throw new Error("Unexpected external request in offline funding test");
    }
    return Response.json({
      quoteResponse: this.rawQuote,
      status: this.terminal ? "SUCCESS" : "PROCESSING",
      updatedAt: new Date().toISOString(),
      swapDetails: {
        intentHashes: [this.hash],
        ...(this.terminal
          ? {
              amountIn: "5000000",
              amountOut: "4990000",
              depositedAmount: "5000000",
              refundedAmount: "0",
              amountInUsd: "5",
              amountOutUsd: "4.99",
            }
          : {}),
      },
    });
  }
}
