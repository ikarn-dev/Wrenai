"use server";
import { randomUUID } from "node:crypto";
import { refresh } from "next/cache";
import { start } from "workflow/api";
import { z } from "zod";
import { AgentError } from "@/server/agents/errors";
import { deployedRuntimeReady } from "@/server/agents/readiness";
import { currentUser, type SessionUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import { consumeRateLimit } from "@/server/http/rate-limit";
import type { AgentResult } from "@/shared/agents";
import { fundingIdInputSchema, type WalletFundingView } from "@/shared/wallet-funding";
import { runWalletFunding } from "@/workflows/wallet-funding";
import { prepareWalletConversion } from "./conversion";
import { confirmWalletDeposit, markWalletFundingAttempt } from "./deposit";
import { prepareWalletFunding } from "./prepare";
import {
  type AgentFundingState,
  discardFundingReview,
  keepFundingPublic,
  readFundingState,
} from "./progress";
import { ownedWalletFunding, walletFundingView } from "./records";

async function fundingAction<T>(run: (user: SessionUser) => Promise<T>): Promise<AgentResult<T>> {
  const user = await currentUser();
  if (!user) {
    return { ok: false, code: "signed_out", message: "Sign in to fund your agent." };
  }
  const rate = await consumeRateLimit(`wallet-funding:${user.id}`, 30, 60000);
  if (rate !== "allowed") {
    return {
      ok: false,
      code: rate === "limited" ? "rate_limited" : "unavailable",
      message: "Funding requests are unavailable. Try again shortly.",
    };
  }
  try {
    return { ok: true, value: await run(user) };
  } catch (error) {
    if (error instanceof AgentError) {
      return { ok: false, code: error.code, message: error.message };
    }
    if (error instanceof ExecutionError) {
      return {
        ok: false,
        code: error.code === "not_found" ? "not_found" : "not_ready",
        message: error.message,
      };
    }
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        code: "invalid_input",
        message: "The deposit data could not be verified. Check the token amount and transaction hash.",
      };
    }
    return {
      ok: false,
      code: "unavailable",
      message: "Funding could not be confirmed. Check its status before sending again.",
    };
  }
}
export async function loadAgentFunding(raw: unknown): Promise<AgentResult<AgentFundingState>> {
  return fundingAction((user) =>
    readFundingState(database(), user, z.strictObject({ agentId: z.uuid() }).parse(raw).agentId),
  );
}
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
