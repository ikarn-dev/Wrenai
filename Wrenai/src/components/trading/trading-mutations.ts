"use client";

import { z } from "zod";
import { type WalletPaymentView, walletPaymentViewSchema } from "@/shared/chat-payment";
import { type ManualPreview, manualPreviewSchema, type TradingResult } from "@/shared/manual-trading";
import {
  type PaymentTopUpView,
  paymentTopUpViewSchema,
  type WalletSwapView,
  walletSwapViewSchema,
} from "@/shared/wallet-swap";
import { postTrading } from "./trading-api";

// Trading mutations as POSTs to route handlers (src/app/api/trading), not Server Actions: Next runs Server Actions
// one at a time per client and holds the router while they run, so a quote or a receipt check froze the page
// ("Rendering…") and queued every other action behind it. Same names and results as the actions they replace.

const ORDERS = "/api/trading/orders";
const SWAPS = "/api/trading/wallet-swaps";
const PAYMENTS = "/api/trading/payments";
const privateReviewSchema = z.strictObject({
  private: manualPreviewSchema.nullable(),
  topUp: paymentTopUpViewSchema.nullable(),
});

export function requestManualQuote(input: unknown): Promise<TradingResult<ManualPreview>> {
  return postTrading(ORDERS, { step: "quote", input }, manualPreviewSchema);
}

/** Resolves a Jarvis quote request's token hints on the server, then quotes it. */
export function requestChatSpotQuote(input: unknown): Promise<TradingResult<ManualPreview>> {
  return postTrading(ORDERS, { step: "chat_quote", input }, manualPreviewSchema);
}

export function confirmManualOrder(input: unknown): Promise<TradingResult<ManualPreview>> {
  return postTrading(ORDERS, { step: "confirm", input }, manualPreviewSchema);
}

export function dismissManualOrder(input: unknown): Promise<TradingResult<null>> {
  return postTrading(ORDERS, { step: "dismiss", input }, z.null());
}

export function requestWalletSwap(input: unknown): Promise<TradingResult<WalletSwapView>> {
  return postTrading(SWAPS, { step: "request", input }, walletSwapViewSchema);
}

export function startWalletSwap(input: unknown): Promise<TradingResult<WalletSwapView>> {
  return postTrading(SWAPS, { step: "start", input }, walletSwapViewSchema);
}

export function recordWalletSwap(input: unknown): Promise<TradingResult<WalletSwapView>> {
  return postTrading(SWAPS, { step: "record", input }, walletSwapViewSchema);
}

export function dismissWalletSwap(input: unknown): Promise<TradingResult<null>> {
  return postTrading(SWAPS, { step: "dismiss", input }, z.null());
}

export function reviewPublicPayment(input: unknown): Promise<TradingResult<WalletPaymentView>> {
  return postTrading(PAYMENTS, { step: "review_public", input }, walletPaymentViewSchema);
}

export function approvePublicPayment(input: unknown): Promise<TradingResult<WalletPaymentView>> {
  return postTrading(PAYMENTS, { step: "approve_public", input }, walletPaymentViewSchema);
}

export function confirmPublicPayment(input: unknown): Promise<TradingResult<WalletPaymentView>> {
  return postTrading(PAYMENTS, { step: "confirm_public", input }, walletPaymentViewSchema);
}

export function reviewPrivatePayment(
  input: unknown,
): Promise<TradingResult<z.output<typeof privateReviewSchema>>> {
  return postTrading(PAYMENTS, { step: "review_private", input }, privateReviewSchema);
}

export function approvePrivateTopUp(input: unknown): Promise<TradingResult<PaymentTopUpView>> {
  return postTrading(PAYMENTS, { step: "approve_top_up", input }, paymentTopUpViewSchema);
}

export function recordPrivateTopUp(input: unknown): Promise<TradingResult<PaymentTopUpView>> {
  return postTrading(PAYMENTS, { step: "record_top_up", input }, paymentTopUpViewSchema);
}

export function resumePrivateTopUp(input: unknown): Promise<TradingResult<null>> {
  return postTrading(PAYMENTS, { step: "resume_top_up", input }, z.null());
}
