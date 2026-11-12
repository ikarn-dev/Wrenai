import "server-only";
import { createPublicKey, createSecretKey } from "node:crypto";
import { z } from "zod";
import { chatCipher } from "@/server/chat/cipher";
import { ed25519KeyFromSeed } from "@/server/near/ed25519-key";
import { TESTNET_ASSETS } from "@/shared/testnet";
import { parseTokenAmount } from "@/shared/token-units";

import { ACTION_CAPS, GUEST_GRANTS, TESTNET_POLICY } from "./policy";
export class TestnetError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "invalid_input"
      | "limit"
      | "conflict"
      | "unauthorized"
      | "funding_required",
    message: string,
  ) {
    super(message);
    this.name = "TestnetError";
  }
}
export function testnetEnv() {
  const schema = z.object({
    APP_URL: z.url({ protocol: /^https?$/ }),
    TESTNET_POOL_SEED: z.base64().refine((v) => Buffer.from(v, "base64").length === 32),
    TESTNET_KEY_ENCRYPTION_KEY: z.base64().refine((v) => Buffer.from(v, "base64").length === 32),
  });
  const config = schema.safeParse(process.env);
  if (!config.success) {
    throw new TestnetError(
      "unavailable",
      "Guest access needs a valid APP_URL, wallet seed and encryption key.",
    );
  }
  if (
    config.data.TESTNET_KEY_ENCRYPTION_KEY === process.env["KEY_ENCRYPTION_KEY"] ||
    config.data.TESTNET_KEY_ENCRYPTION_KEY === config.data.TESTNET_POOL_SEED
  ) {
    throw new TestnetError("unavailable", "Use an independent testnet encryption key.");
  }
  const allowances = TESTNET_ASSETS.map((t) => ({
    assetId: t.id,
    units: GUEST_GRANTS[t.id] ? parseTokenAmount(GUEST_GRANTS[t.id] ?? "", t.decimals) : 0n,
    cap: ACTION_CAPS[t.id] ? parseTokenAmount(ACTION_CAPS[t.id] ?? "", t.decimals) : 0n,
  })).filter((a) => a.units > 0n || a.cap > 0n);
  const seed = Buffer.from(config.data.TESTNET_POOL_SEED, "base64");
  let account: string;
  try {
    account = createPublicKey(ed25519KeyFromSeed(seed))
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex");
  } finally {
    seed.fill(0);
  }
  return {
    ...config.data,
    ...TESTNET_POLICY,
    TESTNET_POOL_ACCOUNT_ID: account,
    allowances,
    origin: new URL(config.data.APP_URL).origin,
  };
}
export function testnetCipher() {
  const env = testnetEnv();
  return chatCipher(createSecretKey(Buffer.from(env.TESTNET_KEY_ENCRYPTION_KEY, "base64")));
}
