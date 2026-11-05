"use server";
import { randomUUID } from "node:crypto";
import { refresh } from "next/cache";
import { start } from "workflow/api";
import { deployedRuntimeReady } from "@/server/agents/readiness";
import { database } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import type { AgentResult } from "@/shared/agents";
import { fundingIdInputSchema, type WalletFundingView } from "@/shared/wallet-funding";
import { runWalletFunding } from "@/workflows/wallet-funding";
import { fundingAction } from "./access";
import { prepareWalletConversion } from "./conversion";
import { confirmWalletDeposit, markWalletFundingAttempt } from "./deposit";
import { prepareWalletFunding } from "./prepare";
import { discardFundingReview, keepFundingPublic } from "./progress";
import { ownedWalletFunding, walletFundingView } from "./records";

export async function reviewWalletFunding(raw: unknown): Promise<AgentResult<WalletFundingView>> {
  return fundingAction((user) => {
    if (!deployedRuntimeReady()) {
      throw new ExecutionError("not_ready", "Deploy the trading workflow before depositing agent funds.");
    }
    return prepareWalletFunding(database(), user, raw);
  });
}
export async function beginWalletFunding(raw: unknown): Promise<AgentResult<WalletFundingView>> {
  return fundingAction((user) => markWalletFundingAttempt(database(), user, raw));
}
export async function submitWalletFundingProof(raw: unknown): Promise<AgentResult<WalletFundingView>> {
  return fundingAction(async (user) => {
    const row = await confirmWalletDeposit(database(), user, raw);
    refresh();
    return row;
  });
}
export async function continueWalletFunding(raw: unknown): Promise<AgentResult<WalletFundingView>> {
  return fundingAction(async (user) => {
    if (!deployedRuntimeReady()) {
      throw new ExecutionError("not_ready", "Deploy the trading workflow before moving agent funds.");
    }
    const { fundingId } = fundingIdInputSchema.parse(raw),
      db = database();
    await prepareWalletConversion(db, user, fundingId);
    // Queue acknowledgement can be retried; the persisted action and Signer lease prevent a duplicate send.
    await start(runWalletFunding, [user.id, fundingId, randomUUID(), 0]);
    refresh();
    return walletFundingView(await ownedWalletFunding(db, user.id, fundingId));
  });
}
export async function cancelWalletFundingReview(raw: unknown): Promise<AgentResult<null>> {
  return fundingAction(async (user) => {
    await discardFundingReview(database(), user.id, fundingIdInputSchema.parse(raw).fundingId);
    refresh();
    return null;
  });
}
export async function stopPrivateFunding(raw: unknown): Promise<AgentResult<null>> {
  return fundingAction(async (user) => {
    await keepFundingPublic(database(), user.id, fundingIdInputSchema.parse(raw).fundingId);
    refresh();
    return null;
  });
}
