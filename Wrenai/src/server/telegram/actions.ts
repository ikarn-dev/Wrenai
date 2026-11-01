"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { AgentError, agentFailure } from "@/server/agents/errors";
import { currentUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { consumeRateLimit } from "@/server/http/rate-limit";
import type { AgentResult } from "@/shared/agents";
import type { TelegramLinkState } from "@/shared/telegram";
import {
  beginTelegramLink,
  cancelTelegramLink,
  confirmTelegramLink,
  readTelegramLinkState,
  unlinkTelegram,
} from "./linking";

async function telegramAction(
  run: (userId: string) => Promise<TelegramLinkState>,
): Promise<AgentResult<TelegramLinkState>> {
  try {
    const user = await currentUser();
    if (user === null) {
      throw new AgentError("signed_out", "Sign in again to manage Telegram.");
    }
    const decision = await consumeRateLimit(`agents:manage:${user.id}`, 30, 60_000);
    if (decision !== "allowed") {
      throw new AgentError(
        decision === "limited" ? "rate_limited" : "unavailable",
        "Telegram settings are unavailable. Try again shortly.",
      );
    }
    const state = await run(user.id);
    refresh();
    return { ok: true, value: state };
  } catch (error) {
    if (error instanceof AgentError) {
      return agentFailure(error);
    }
    if (error instanceof z.ZodError) {
      return agentFailure(new AgentError("invalid_input", "Check your Telegram connection and try again."));
    }
    throw error;
  }
}
export async function startTelegramLink(raw: unknown): Promise<AgentResult<TelegramLinkState>> {
  return telegramAction((id) => beginTelegramLink(database(), id, raw));
}
export async function checkTelegramLink(raw: unknown): Promise<AgentResult<TelegramLinkState>> {
  return telegramAction((id) => {
    z.strictObject({}).parse(raw);
    return readTelegramLinkState(database(), id);
  });
}
export async function finishTelegramLink(raw: unknown): Promise<AgentResult<TelegramLinkState>> {
  return telegramAction((id) => confirmTelegramLink(database(), id, raw));
}
export async function discardTelegramLink(raw: unknown): Promise<AgentResult<TelegramLinkState>> {
  return telegramAction((id) => cancelTelegramLink(database(), id, raw));
}
export async function disconnectTelegram(raw: unknown): Promise<AgentResult<TelegramLinkState>> {
  return telegramAction((id) => unlinkTelegram(database(), id, raw));
}
