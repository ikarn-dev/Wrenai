import "server-only";
import type { HlUsdSend } from "@/shared/perps-return";
import { tradingResponseJson } from "../trading-http";
import type { HlAction } from "./contracts";
import type { HlSignature } from "./signing";

export async function hlInfo(
  body: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
  exactNumbers = false,
): Promise<unknown> {
  return tradingResponseJson(
    await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "wrenai/0.1" },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
    }),
    2_000_000,
    exactNumbers,
  );
}
/** User-signed USDC transfers do not support expiresAfter. Their journal must never be replayed. */
export async function hlTransfer(action: HlUsdSend, signature: HlSignature): Promise<unknown> {
  return tradingResponseJson(
    await fetch("https://api.hyperliquid.xyz/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "wrenai/0.1" },
      body: JSON.stringify({ action, nonce: action.time, signature }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    }),
    128_000,
  );
}
/** No automatic resend: the caller journals the signed request before calling this once. */
export async function hlExchange(
  action: HlAction,
  nonce: number,
  expiresAfter: number,
  signature: HlSignature,
): Promise<unknown> {
  return tradingResponseJson(
    await fetch("https://api.hyperliquid.xyz/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "wrenai/0.1" },
      body: JSON.stringify({ action, nonce, signature, vaultAddress: null, expiresAfter }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    }),
    128_000,
  );
}
