import "server-only";
import { z } from "zod";
import { InferenceError } from "@/server/ai/verified-completion";
import { currentUser, type SessionUser } from "@/server/auth/session";
import { consumeRateLimit } from "@/server/http/rate-limit";
import type { ChatResult } from "@/shared/chat";
import { ChatError } from "./errors";

export async function chatUser(kind: "reply" | "manage"): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) {
    throw new ChatError("signed_out", "Sign in again to use chat.");
  }
  const decision = await consumeRateLimit(`chat:${kind}:${user.id}`, kind === "reply" ? 6 : 40, 60_000);
  if (decision !== "allowed") {
    throw new ChatError(
      decision === "limited" ? "rate_limited" : "unavailable",
      decision === "limited"
        ? "Too many requests. Wait a minute and try again."
        : "Request protection is unavailable. Try again shortly.",
    );
  }
  return user;
}

export async function chatResult<T>(run: () => Promise<T>): Promise<ChatResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof ChatError || error instanceof InferenceError) {
      return { ok: false, code: error.code, message: error.message };
    }
    if (error instanceof z.ZodError) {
      return { ok: false, code: "invalid_input", message: "Check your message and try again." };
    }
    return { ok: false, code: "unavailable", message: "Chat is unavailable. Try again shortly." };
  }
}
