import "server-only";
import { z } from "zod";
import { clientAddress, consumeRateLimit } from "@/server/http/rate-limit";
import { reportUnexpectedError } from "@/server/http/unexpected-error";
import { TestnetError, testnetEnv } from "./config";

const PRIVATE = { "Cache-Control": "private, no-store" };
export function testnetFailure(error: unknown): Response {
  if (error instanceof TestnetError) {
    return Response.json(
      { ok: false, code: error.code, message: error.message },
      {
        status:
          error.code === "unauthorized"
            ? 401
            : error.code === "limit"
              ? 429
              : error.code === "invalid_input"
                ? 400
                : error.code === "conflict" || error.code === "funding_required"
                  ? 409
                  : 503,
        headers: PRIVATE,
      },
    );
  }
  if (error instanceof z.ZodError || error instanceof RangeError) {
    return Response.json(
      { ok: false, code: "invalid_input", message: "Check the testnet request and try again." },
      { status: 400, headers: PRIVATE },
    );
  }
  reportUnexpectedError("trading", error);
  return Response.json(
    {
      ok: false,
      code: "unavailable",
      message: "Testnet is unavailable. Existing transactions remain tracked; do not send again.",
    },
    { status: 503, headers: PRIVATE },
  );
}
export async function protectTestnet(request: Request, write: boolean, owner = "session"): Promise<void> {
  if (
    write &&
    (request.headers.get("origin") !== testnetEnv().origin ||
      !request.headers.get("content-type")?.startsWith("application/json"))
  ) {
    throw new TestnetError("invalid_input", "Open Wrenai Testnet to confirm this request.");
  }
  const result = await consumeRateLimit(
    `testnet:${write ? "write" : "read"}:${owner}:${await clientAddress()}`,
    write ? 30 : 120,
    60000,
  );
  if (result !== "allowed") {
    throw new TestnetError(
      result === "limited" ? "limit" : "unavailable",
      "Testnet request protection is busy. Try shortly.",
    );
  }
}
export async function testnetBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > 12000) {
    throw new TestnetError("invalid_input", "Shorten this request.");
  }
  const reader = request.body?.getReader();
  if (!reader) {
    throw new TestnetError("invalid_input", "A request body is required.");
  }
  const pieces: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const p = await reader.read();
      if (p.done) {
        break;
      }
      size += p.value.length;
      if (size > 12000) {
        await reader.cancel();
        throw new TestnetError("invalid_input", "Shorten this request.");
      }
      pieces.push(p.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(pieces).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TestnetError("invalid_input", "Invalid JSON request.");
    }
    throw error;
  }
}
export function testnetJson(data: unknown): Response {
  return Response.json({ ok: true, data }, { headers: PRIVATE });
}
