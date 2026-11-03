"use server";
import { refresh } from "next/cache";
import { start } from "workflow/api";
import { z } from "zod";
import { AgentError } from "@/server/agents/errors";
import { deployedRuntimeReady } from "@/server/agents/readiness";
import { currentUser, type SessionUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { advanceLedgerAction } from "@/server/engine/ledger-action";
import { consumeRateLimit } from "@/server/http/rate-limit";
import type { AgentResult } from "@/shared/agents";
import type { PerpsReturnPreview } from "@/shared/perps-return";
import { runPerpsReturn } from "@/workflows/perps-return";
import { ExecutionError } from "./contracts";
import { preparePerpsReturn } from "./hyperliquid/return-prepare";
import { createPerpsReturnPreview } from "./hyperliquid/return-preview";
import { ownedLedgerAction } from "./records";

async function protectedReturn<T>(run: (user: SessionUser) => Promise<T>): Promise<AgentResult<T>> {
  const user = await currentUser();
  if (!user) {
    return { ok: false, code: "signed_out", message: "Sign in to return your Perps funds." };
  }
  const rate = await consumeRateLimit(`perps-return:${user.id}`, 10, 60_000);
  if (rate !== "allowed") {
    return {
      ok: false,
      code: rate === "limited" ? "rate_limited" : "unavailable",
      message: "Return requests are unavailable. Try again shortly.",
    };
  }
  if (!deployedRuntimeReady()) {
    return {
      ok: false,
      code: "not_ready",
      message: "The deployed trading runtime is required to track this return.",
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
        message: "The return data could not be verified. Request a fresh preview.",
      };
    }
    return {
      ok: false,
      code: "unavailable",
      message: "The return could not be confirmed. Check this agent's orders before trying again.",
    };
  }
}
export async function previewPerpsReturn(raw: unknown): Promise<AgentResult<PerpsReturnPreview>> {
  return protectedReturn((user) => createPerpsReturnPreview(database(), user, raw));
}
export async function confirmPerpsReturn(
  raw: unknown,
): Promise<AgentResult<{ readonly actionId: string; readonly status: string; readonly tracking: boolean }>> {
  return protectedReturn(async (user) => {
    const db = database(),
      action = await preparePerpsReturn(db, user, raw);
    // Confirmation reuses the same request. A failed queue acknowledgement cannot create another transfer.
    try {
      await advanceLedgerAction(db, user.id, action.id);
    } catch {
      const current = await ownedLedgerAction(db, user.id, action.id);
      if (current.status === "reserved") {
        throw new ExecutionError(
          "not_ready",
          "The return has not been submitted. Retry this same confirmation.",
        );
      }
    }
    const current = await ownedLedgerAction(db, user.id, action.id);
    let tracking = current.reservationReleasedAt !== null;
    if (!tracking) {
      try {
        await start(runPerpsReturn, [user.id, action.id, 0]);
        tracking = true;
      } catch {
        tracking = false;
      }
    }
    refresh();
    return { actionId: action.id, status: current.status, tracking };
  });
}
