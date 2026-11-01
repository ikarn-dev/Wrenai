import { database } from "@/server/db/client";
import { consumeRateLimit } from "@/server/http/rate-limit";
import { validWebhookSecret } from "@/server/telegram/config";
import { claimTelegramLink } from "@/server/telegram/linking";
import { parseTelegramStart } from "@/server/telegram/update";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 32_768;

async function boundedBody(request: Request): Promise<string | null> {
  if (request.body === null) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return Buffer.concat(chunks).toString("utf8");
      }
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!validWebhookSecret(request.headers.get("x-telegram-bot-api-secret-token"))) {
    return Response.json({ ok: false }, { status: 403 });
  }
  const ingress = await consumeRateLimit("telegram:webhook", 120, 60_000);
  if (ingress !== "allowed") {
    return Response.json({ ok: false }, { status: ingress === "limited" ? 429 : 503 });
  }
  const body = await boundedBody(request);
  if (body === null) {
    return Response.json({ ok: false }, { status: 413 });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return Response.json({ ok: false }, { status: 400 });
  }
  const start = parseTelegramStart(raw);
  if (start === null) {
    return Response.json({ ok: true });
  }
  const decision = await consumeRateLimit(`telegram:link:${start.telegramUserId}`, 30, 60_000);
  if (decision !== "allowed") {
    return Response.json({ ok: false }, { status: decision === "limited" ? 429 : 503 });
  }
  const claimed = await claimTelegramLink(database(), start);
  // Telegram's webhook reply method has no delivery receipt; never treat this reply as a confirmed link.
  return Response.json({
    method: "sendMessage",
    chat_id: start.chatId,
    text: claimed
      ? "Return to Wrenai Settings to review and confirm this Telegram account."
      : "This link is no longer available. Create a new Telegram link in Wrenai Settings.",
  });
}
