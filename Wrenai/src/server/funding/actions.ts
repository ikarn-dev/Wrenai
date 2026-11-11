import "server-only";
import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import { z } from "zod";
import { deployedRuntimeReady } from "@/server/agents/readiness";
import { database } from "@/server/db/client";
import { ExecutionError } from "@/server/execution/contracts";
import type { AgentResult } from "@/shared/agents";
import { directNativeFunding, fundingIdInputSchema, type WalletFundingView } from "@/shared/wallet-funding";
import { runWalletFunding } from "@/workflows/wallet-funding";
import { fundingAction } from "./access";
import { releaseWalletAttempt } from "./cancel";
import { prepareWalletConversion } from "./conversion";
import { confirmWalletDeposit, markWalletFundingAttempt } from "./deposit";
import { prepareWalletFunding } from "./prepare";
import { discardFundingReview, keepFundingPublic } from "./progress";
import { ownedWalletFunding, walletFundingView } from "./records";

const commandSchema = z.strictObject({
  command: z.enum(["review", "begin", "proof", "continue", "cancel", "public", "decline"]),
  input: z.unknown(),
});
const RUNTIME_OFF =
  "Funding needs the trading workflow: run on Vercel, or set WRENAI_LOCAL_EXECUTION=1 locally.";

/**
 * Every wallet funding step, sent to a route handler rather than run as a Server Action: Next holds the router while a
 * Server Action runs, which re-rendered the page behind the deploy dialog on each step.
 */
export async function runFundingCommand(raw: unknown): Promise<AgentResult<WalletFundingView | null>> {
  return fundingAction(async (user) => {
    const { command, input } = commandSchema.parse(raw),
      db = database();
    switch (command) {
      case "review":
        if (!deployedRuntimeReady()) {
          throw new ExecutionError("not_ready", RUNTIME_OFF);
        }
        return prepareWalletFunding(db, user, input);
      case "begin":
        return markWalletFundingAttempt(db, user, input);
      case "proof":
        return confirmWalletDeposit(db, user, input);
      case "continue": {
        if (!deployedRuntimeReady()) {
          throw new ExecutionError("not_ready", RUNTIME_OFF);
        }
        const { fundingId } = fundingIdInputSchema.parse(input);
        const row = await ownedWalletFunding(db, user.id, fundingId);
        // A native NEAR deposit needs no conversion: 1Click delivers it, and the workflow only waits for that.
        if (!directNativeFunding(walletFundingView(row).snapshot)) {
          await prepareWalletConversion(db, user, fundingId);
        }
        // Queue acknowledgement can be retried; persisted state and the Signer lease prevent a duplicate send.
        await start(runWalletFunding, [user.id, fundingId, randomUUID(), 0]);
        return walletFundingView(await ownedWalletFunding(db, user.id, fundingId));
      }
      case "cancel":
        await discardFundingReview(db, user.id, fundingIdInputSchema.parse(input).fundingId);
        return null;
      case "public":
        await keepFundingPublic(db, user.id, fundingIdInputSchema.parse(input).fundingId);
        return null;
      case "decline":
        await releaseWalletAttempt(db, user.id, input);
        return null;
      default: {
        const unhandled: never = command;
        throw new Error(`Unhandled funding command: ${String(unhandled)}`);
      }
    }
  });
}
