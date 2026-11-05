import { createSecretKey } from "node:crypto";
import { testDatabase } from "@tests/server/db/test-database";
import { rheaHash, rheaNativeOutcome } from "@tests/server/wallet-swap/rhea-native-fixture";
import { mockRheaQuote, walletSwapChatInput } from "@tests/server/wallet-swap/rhea-native-quote-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { chatCipher } from "@/server/chat/cipher";
import { answerChat } from "@/server/chat/service";
import { walletSwaps } from "@/server/db/wallet-swap-schema";
import { readIntentsProviderStatus } from "@/server/execution/intents-reconciliation";
import { oneClickJson } from "@/server/execution/oneclick-quote";
import {
  callViewFunction,
  finalBlockTime,
  NearRpcError,
  readContractCodeHash,
  readFinalTransaction,
} from "@/server/near/rpc";
import { intentTokens } from "@/server/research/intents";
import {
  beginWalletSwap,
  cancelWalletSwap,
  prepareWalletSwap,
  readWalletSwap,
  submitWalletSwap,
} from "@/server/wallet-swap/service";
import type { ChatEvent } from "@/shared/chat";
import {
  WALLET_SWAP_INPUT,
  WALLET_SWAP_NATIVE_OUTPUT,
  WALLET_SWAP_USDC,
  type WalletSwapView,
  walletSwapTransaction,
} from "@/shared/wallet-swap";

const outputAssetId = WALLET_SWAP_USDC;
const inputUnits = "100000000000000000000000";
const outputUnits = 401751n;
const minimumAt50Bps = "399743";
const hash = "8".repeat(44);
const requestSchema = z.looseObject({
  amount: z.string(),
  slippageTolerance: z.number().int(),
  deadline: z.iso.datetime(),
});

vi.mock("server-only", () => ({}));
vi.mock("@defuse-protocol/one-click-sdk-typescript", async (original) => ({
  ...(await original<typeof import("@defuse-protocol/one-click-sdk-typescript")>()),
  verifyQuoteSignature: () => true,
}));
vi.mock("@/server/execution/oneclick-quote", async (original) => ({
  ...(await original<typeof import("@/server/execution/oneclick-quote")>()),
  oneClickJson: vi.fn(),
}));
vi.mock("@/server/execution/intents-reconciliation", async (original) => ({
  ...(await original<typeof import("@/server/execution/intents-reconciliation")>()),
  readIntentsProviderStatus: vi.fn(),
}));
vi.mock("@/server/near/rpc", async (original) => ({
  ...(await original<typeof import("@/server/near/rpc")>()),
  readFinalTransaction: vi.fn(),
  callViewFunction: vi.fn(),
  finalBlockTime: vi.fn(),
  readContractCodeHash: vi.fn(),
}));
vi.mock("@/server/ai/chat-preparation", () => ({
  prepareChatInference: async () => {
    throw new Error("AI unavailable");
  },
}));
vi.mock("@/server/chat/context", () => ({
  readChatContext: async () => {
    throw new Error("Optional context unavailable");
  },
}));
vi.mock("@/server/research/intents", () => ({
  intentTokens: vi.fn(async () => ({
    tokens: [
      { assetId: WALLET_SWAP_INPUT, symbol: "wNEAR", decimals: 24, blockchain: "near" },
      {
        assetId: outputAssetId,
        symbol: "USDC",
        decimals: 6,
        blockchain: "near",
        contractAddress: outputAssetId.slice("nep141:".length),
      },
    ],
  })),
}));
const wallet = vi.hoisted(() => ({ holding: vi.fn() }));
vi.mock("@/server/portfolio/wallet-tokens", () => ({
  walletTokenHolding: wallet.holding,
}));

function mockQuote(minimumOutput?: string) {
  vi.mocked(oneClickJson).mockImplementationOnce(async (_path, body) => {
    const request = requestSchema.parse(body);
    const roundedMinimum = (outputUnits * BigInt(10_000 - request.slippageTolerance)) / 10_000n;
    return {
      correlationId: "offline-wallet-quote",
      timestamp: new Date().toISOString(),
      signature: "offline-provider-signature",
      quoteRequest: { ...request, appFees: [{ recipient: "partner.near", fee: 20 }] },
      quote: {
        amountIn: request.amount,
        minAmountIn: request.amount,
        amountOut: outputUnits.toString(),
        minAmountOut: minimumOutput ?? roundedMinimum.toString(),
        amountInFormatted: "0.1",
        amountOutFormatted: "0.401751",
        amountInUsd: "0.4",
        amountOutUsd: "0.401751",
        timeEstimate: 1,
        depositAddress: "a".repeat(64),
        deadline: request.deadline,
      },
    };
  });
}

function prepareRhea(amount = "0.1") {
  return prepareWalletSwap(store.db, "owner", {
    requestId: crypto.randomUUID(),
    amount,
    inputAssetId: WALLET_SWAP_USDC,
    outputAssetId: WALLET_SWAP_NATIVE_OUTPUT,
    slippageBps: 50,
    maximumFeeBps: 1,
  });
}

let store: Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async () => {
  vi.mocked(oneClickJson).mockReset();
  vi.mocked(readFinalTransaction).mockReset();
  vi.mocked(readIntentsProviderStatus).mockReset();
  vi.mocked(callViewFunction)
    .mockReset()
    .mockResolvedValue({
      value: { min: "1250000000000000000000" },
      blockHeight: 1,
    });
  vi.mocked(finalBlockTime).mockReset().mockResolvedValue(Date.now());
  vi.mocked(readContractCodeHash).mockReset();
  wallet.holding
    .mockReset()
    .mockImplementation(async (_account: string, asset: string) =>
      asset === outputAssetId
        ? { spendableUnits: "396272", decimals: 6 }
        : { spendableUnits: "579000000000000000000000", decimals: 24 },
    );
  store = await testDatabase();
});
afterEach(async () => {
  await store.postgres.close();
});

function prepare() {
  return prepareWalletSwap(store.db, "owner", {
    requestId: crypto.randomUUID(),
    amount: "0.1",
    outputAssetId,
    slippageBps: 50,
    maximumFeeBps: 20,
  });
}

describe("wallet swap quote rounding", () => {
  it("allows provider rounding while keeping the reviewed slippage and exact debit", async () => {
    mockQuote();
    const swap = await prepare();
    expect(oneClickJson).toHaveBeenCalledExactlyOnceWith(
      "/v0/quote",
      expect.objectContaining({ slippageTolerance: 49, amount: inputUnits, depositType: "ORIGIN_CHAIN" }),
      undefined,
    );
    expect(swap).toMatchObject({
      state: "quoted",
      quote: {
        depositKind: "native_near",
        request: { slippageBps: 50, maximumFeeBps: 20 },
        inputUnits,
        minimumOutputUnits: "399782",
        appFeeBps: 20,
      },
    });
  });

  it("rejects a quote one base unit below the reviewed minimum", async () => {
    mockQuote((BigInt(minimumAt50Bps) - 1n).toString());
    await expect(prepare()).rejects.toThrow("minimum output exceeds the selected limits");
    expect(await store.db.select().from(walletSwaps)).toHaveLength(0);
  });
});

function nativeReceipt(swap: WalletSwapView) {
  return {
    final_execution_status: "FINAL",
    transaction: {
      hash,
      signer_id: swap.quote.accountId,
      receiver_id: swap.quote.depositAddress,
      actions: [{ Transfer: { deposit: swap.quote.inputUnits } }],
    },
    status: { SuccessValue: "" },
  };
}

function settledStatus(swap: WalletSwapView) {
  return {
    quoteResponse: { quote: { depositAddress: swap.quote.depositAddress } },
    status: "SUCCESS",
    updatedAt: new Date().toISOString(),
    swapDetails: { intentHashes: [], originChainTxHashes: [{ hash }], amountOut: "401751" },
  };
}

describe("wallet NEAR to USDC flow", () => {
  it("quotes all available wallet USDC and binds one token transfer for wNEAR", async () => {
    mockQuote();
    const events: ChatEvent[] = [];
    await answerChat(
      store.db,
      { id: "owner", accountId: "owner.near" },
      {
        requestId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        previousTurnId: null,
        includeContext: false,
        message: "swap all usdc in my wallet to wnear",
      },
      chatCipher(createSecretKey(Buffer.alloc(32, 5))),
      undefined,
      (event) => events.push(event),
    );
    const done = events.find((event) => event.type === "done");
    expect(done?.turn.reply?.manual?.text).toBe("Review your quote below.");
    const quote = done?.walletSwap?.quote;
    expect(quote).toMatchObject({
      inputUnits: "396272",
      depositKind: "nep141",
      output: { assetId: WALLET_SWAP_INPUT, tokenSymbol: "wNEAR" },
    });
    expect(quote && walletSwapTransaction(quote)).toMatchObject({
      signerId: "owner.near",
      receiverId: outputAssetId.slice("nep141:".length),
      actions: [
        { params: { methodName: "storage_deposit", deposit: "1250000000000000000000" } },
        { params: { methodName: "ft_transfer", args: { receiver_id: "a".repeat(64), amount: "396272" } } },
      ],
    });
  });
  it.each([false, true])(
    "quotes and settles native NEAR without 1Click or inference (saved question: %s)",
    async (resume) => {
      mockRheaQuote();
      vi.mocked(intentTokens).mockClear();
      const cipher = chatCipher(createSecretKey(Buffer.alloc(32, 5)));
      const input = await walletSwapChatInput(store.db, cipher, resume);
      const turn = await answerChat(store.db, { id: "owner", accountId: "owner.near" }, input, cipher);
      expect(turn.reply?.manual?.walletSwapIds).toEqual([input.requestId]);
      expect(intentTokens).not.toHaveBeenCalled();
      const started = await beginWalletSwap(store.db, "owner", { id: input.requestId });
      expect(started.quote).toMatchObject({ depositKind: "rhea_native", inputUnits: "396272" });
      vi.mocked(readFinalTransaction).mockResolvedValueOnce(rheaNativeOutcome(started.quote));
      const settled = await submitWalletSwap(store.db, "owner", {
        id: input.requestId,
        transactionHash: rheaHash,
      });
      expect(settled).toMatchObject({ state: "settled", receivedUnits: started.quote.outputUnits });
    },
  );
  it("requires a fresh request for an earlier unsigned wallet quote", async () => {
    mockQuote();
    const swap = await prepare();
    const { pairVerified: _pair, ...previous } = swap.quote;
    await store.db.update(walletSwaps).set({ quoteJson: JSON.stringify(previous) });
    await expect(readWalletSwap(store.db, "owner", { id: swap.id })).resolves.toMatchObject({
      state: "expired",
    });
    await expect(beginWalletSwap(store.db, "owner", { id: swap.id })).rejects.toThrow("exact tokens");
  });
  it("streams an exact quote with its saved card even when AI and optional context are unavailable", async () => {
    mockQuote();
    const requestId = crypto.randomUUID();
    const events: ChatEvent[] = [];
    const turn = await answerChat(
      store.db,
      { id: "owner", accountId: "owner.near" },
      {
        requestId,
        conversationId: crypto.randomUUID(),
        previousTurnId: null,
        includeContext: true,
        message: "quote 0.1 near to usdc",
      },
      chatCipher(createSecretKey(Buffer.alloc(32, 5))),
      undefined,
      (event) => events.push(event),
    );
    expect(turn.reply).toMatchObject({
      receipt: null,
      context: null,
      manual: { tradeIds: [], walletSwapIds: [requestId] },
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      walletSwap: {
        id: requestId,
        state: "quoted",
        quote: { depositKind: "native_near", inputUnits, output: { assetId: outputAssetId } },
      },
    });
    expect(await store.db.select().from(walletSwaps)).toMatchObject([
      { id: requestId, state: "quoted", transactionHash: null },
    ]);
  });

  it("streams a quote rejection code with the saved reply and no swap card", async () => {
    mockQuote((BigInt(minimumAt50Bps) - 1n).toString());
    const events: ChatEvent[] = [];
    await answerChat(
      store.db,
      { id: "owner", accountId: "owner.near" },
      {
        requestId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        previousTurnId: null,
        includeContext: false,
        message: "quote 0.1 near to usdc",
      },
      chatCipher(createSecretKey(Buffer.alloc(32, 5))),
      undefined,
      (event) => events.push(event),
    );
    expect(events.at(-1)).toMatchObject({
      type: "done",
      quoteError: "not_ready",
      turn: { state: "complete", reply: { manual: { tradeIds: [] } } },
    });
    expect(await store.db.select().from(walletSwaps)).toHaveLength(0);
  });

  it("claims approval once and supplies the NEAR sender when notifying 1Click", async () => {
    mockQuote();
    const swap = await prepare();
    await expect(beginWalletSwap(store.db, "owner", { id: swap.id })).resolves.toMatchObject({
      state: "signing",
    });
    await expect(beginWalletSwap(store.db, "owner", { id: swap.id })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(cancelWalletSwap(store.db, "owner", { id: swap.id })).rejects.toMatchObject({
      code: "conflict",
    });
    vi.mocked(readFinalTransaction).mockResolvedValueOnce(nativeReceipt(swap));
    vi.mocked(oneClickJson).mockResolvedValueOnce({});
    await expect(
      submitWalletSwap(store.db, "owner", { id: swap.id, transactionHash: hash }),
    ).resolves.toMatchObject({ state: "submitted", transactionHash: hash });
    expect(oneClickJson).toHaveBeenLastCalledWith("/v0/deposit/submit", {
      txHash: hash,
      depositAddress: swap.quote.depositAddress,
      nearSenderAccount: "owner.near",
    });
  });

  it("recovers the exact finalized deposit and USDC payout if the wallet response was lost", async () => {
    mockQuote();
    const swap = await prepare();
    await beginWalletSwap(store.db, "owner", { id: swap.id });
    vi.mocked(readFinalTransaction).mockResolvedValueOnce(nativeReceipt(swap));
    vi.mocked(readIntentsProviderStatus).mockResolvedValueOnce(settledStatus(swap));
    await expect(readWalletSwap(store.db, "owner", { id: swap.id })).resolves.toMatchObject({
      state: "settled",
      transactionHash: hash,
      receivedUnits: "401751",
    });
    await expect(readWalletSwap(store.db, "stranger", { id: swap.id })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("wallet USDC to native NEAR lifecycle", () => {
  it("rejects approval when NEAR cannot cover the reviewed RHEA gas ceiling", async () => {
    mockRheaQuote();
    wallet.holding.mockImplementation(async (_account: string, asset: string) =>
      asset === WALLET_SWAP_USDC
        ? { spendableUnits: "1000000", decimals: 6 }
        : { spendableUnits: "40000000000000000000000", decimals: 24 },
    );
    await expect(prepareRhea()).rejects.toMatchObject({ code: "insufficient_funds" });
    expect(await store.db.select().from(walletSwaps)).toHaveLength(0);
  });

  it("rechecks pinned contracts before claiming wallet approval", async () => {
    mockRheaQuote();
    const swap = await prepareRhea();
    vi.mocked(readContractCodeHash).mockResolvedValue({
      codeHash: "wrong",
      globalCodeHash: null,
      globalCodeAccount: null,
      blockHash: "6".repeat(44),
    });
    await expect(beginWalletSwap(store.db, "owner", { id: swap.id })).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(await store.db.select().from(walletSwaps)).toMatchObject([
      { state: "quoted", transactionHash: null },
    ]);
  });

  it("saves the first hash before proof and reconciles it from later reads", async () => {
    mockRheaQuote();
    const swap = await prepareRhea();
    await beginWalletSwap(store.db, "owner", { id: swap.id });
    vi.mocked(readFinalTransaction).mockRejectedValueOnce(new NearRpcError("RPC unavailable"));
    await expect(
      submitWalletSwap(store.db, "owner", { id: swap.id, transactionHash: rheaHash }),
    ).resolves.toMatchObject({ state: "submitted", transactionHash: rheaHash });
    expect(await store.db.select().from(walletSwaps)).toMatchObject([
      { state: "submitted", transactionHash: rheaHash, spentUnits: null, receivedUnits: null },
    ]);

    vi.mocked(readFinalTransaction).mockResolvedValueOnce(rheaNativeOutcome(swap.quote));
    await expect(readWalletSwap(store.db, "owner", { id: swap.id })).resolves.toMatchObject({
      state: "settled",
      transactionHash: rheaHash,
      spentUnits: swap.quote.inputUnits,
      receivedUnits: swap.quote.outputUnits,
    });
    expect(readIntentsProviderStatus).not.toHaveBeenCalled();
    expect(oneClickJson).not.toHaveBeenCalled();
  });

  it("keeps proof-incomplete submissions bound and accepts only the same hash", async () => {
    mockRheaQuote();
    const swap = await prepareRhea();
    await beginWalletSwap(store.db, "owner", { id: swap.id });
    const incomplete = rheaNativeOutcome(swap.quote);
    incomplete.receipts_outcome = incomplete.receipts_outcome.filter((item) => item.id !== "payout");
    vi.mocked(readFinalTransaction).mockResolvedValue(incomplete);
    await expect(
      submitWalletSwap(store.db, "owner", { id: swap.id, transactionHash: rheaHash }),
    ).resolves.toMatchObject({ state: "submitted", transactionHash: rheaHash });
    await expect(
      submitWalletSwap(store.db, "owner", { id: swap.id, transactionHash: rheaHash }),
    ).resolves.toMatchObject({ state: "submitted", transactionHash: rheaHash });
    await expect(
      submitWalletSwap(store.db, "owner", { id: swap.id, transactionHash: "9".repeat(44) }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(cancelWalletSwap(store.db, "owner", { id: swap.id })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("leaves signing recoverable when the pasted hash belongs to a different swap", async () => {
    mockRheaQuote();
    const swap = await prepareRhea();
    await beginWalletSwap(store.db, "owner", { id: swap.id });
    const other = rheaNativeOutcome(swap.quote);
    other.transaction.signer_id = "stranger.near";
    vi.mocked(readFinalTransaction)
      .mockResolvedValueOnce(other)
      .mockResolvedValueOnce(rheaNativeOutcome(swap.quote));
    const input = { id: swap.id, transactionHash: rheaHash, fromRecovery: true };
    await expect(submitWalletSwap(store.db, "owner", input)).rejects.toMatchObject({ code: "conflict" });
    await expect(readWalletSwap(store.db, "owner", { id: swap.id })).resolves.toMatchObject({
      state: "signing",
      transactionHash: null,
    });
    await expect(submitWalletSwap(store.db, "owner", input)).resolves.toMatchObject({ state: "settled" });
  });

  it.each([
    { used: 0n, output: 0n, state: "refunded", failed: false },
    { used: undefined, output: undefined, state: "failed", failed: true },
  ] as const)("reconciles a final $state result", async ({ used, output, state, failed }) => {
    mockRheaQuote();
    const swap = await prepareRhea();
    await beginWalletSwap(store.db, "owner", { id: swap.id });
    vi.mocked(readFinalTransaction).mockRejectedValueOnce(new NearRpcError("not indexed yet"));
    await submitWalletSwap(store.db, "owner", { id: swap.id, transactionHash: rheaHash });
    vi.mocked(readFinalTransaction).mockResolvedValueOnce(
      rheaNativeOutcome(swap.quote, {
        ...(used === undefined ? {} : { used }),
        ...(output === undefined ? {} : { output }),
        failed,
      }),
    );
    await expect(readWalletSwap(store.db, "owner", { id: swap.id })).resolves.toMatchObject({
      state,
      transactionHash: rheaHash,
      spentUnits: "0",
      receivedUnits: "0",
    });
  });
});
