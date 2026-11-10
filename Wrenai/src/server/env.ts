import "server-only";
import { createSecretKey, type KeyObject } from "node:crypto";
import { z } from "zod";
import { parseDatabaseUrl } from "./db/connection-url";

const KEY_ENCRYPTION_KEY_BYTES = 32;

// Only variables used by built features are required. Add each new one when its feature ships.
const serverEnvSchema = z.object({
  APP_URL: z.url({ protocol: /^https?$/ }),
  NEAR_RPC_URL: z.url({ protocol: /^https$/ }).default("https://rpc.mainnet.fastnear.com"),
  KEY_ENCRYPTION_KEY: z
    .base64()
    .refine(
      (value) => Buffer.from(value, "base64").length === KEY_ENCRYPTION_KEY_BYTES,
      "Must be 32 bytes in base64. Generate one with: openssl rand -base64 32",
    ),
});

export interface ServerEnv {
  readonly appOrigin: string;
  /** NEP-413 recipient: the app's host, e.g. "localhost:3000". */
  readonly appHost: string;
  readonly secureCookies: boolean;
  readonly nearRpcUrl: string;
  /** Master for delegated-key sealing and domain-separated chat encryption. Logging the KeyObject hides bytes. */
  readonly keyEncryptionKey: KeyObject;
}

let cachedEnv: ServerEnv | undefined;

/** Parses the server environment once. Throws with every invalid variable listed. */
export function serverEnv(): ServerEnv {
  if (cachedEnv !== undefined) {
    return cachedEnv;
  }
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid server environment in Wrenai/.env:\n${z.prettifyError(parsed.error)}`);
  }
  const appUrl = new URL(parsed.data.APP_URL);
  cachedEnv = {
    appOrigin: appUrl.origin,
    appHost: appUrl.host,
    secureCookies: appUrl.protocol === "https:",
    nearRpcUrl: parsed.data.NEAR_RPC_URL,
    keyEncryptionKey: createSecretKey(Buffer.from(parsed.data.KEY_ENCRYPTION_KEY, "base64")),
  };
  return cachedEnv;
}

/** Credentials never appear in validation errors. Prefer the provider's pooled URL. */
export function databaseUrl(): string {
  const { DATABASE_URL } = process.env;
  return parseDatabaseUrl(DATABASE_URL);
}

/** CoinGecko Demo key, required only for the Spot table's market figures. */
export function coingeckoApiKey(): string | null {
  const parsed = z
    .object({
      COINGECKO_API_KEY: z
        .string()
        .trim()
        .regex(/^[\w-]{10,100}$/),
    })
    .safeParse(process.env);
  return parsed.success ? parsed.data.COINGECKO_API_KEY : null;
}

/** The documentation site (DocsSite/) the sidebar links to. Optional and public; defaults to production. */
export function docsUrl(): string {
  const parsed = z
    .object({ DOCS_URL: z.url({ protocol: /^https?$/ }).default("https://docs.wrenai.xyz") })
    .safeParse(process.env);
  return parsed.success ? parsed.data.DOCS_URL : "https://docs.wrenai.xyz";
}
/** Inference credentials are required only for requested strategy parsing or chat replies. */
export function nearAiKeys(): readonly string[] {
  const parsed = z.object({ NEAR_AI_API_KEY: z.string().trim().min(1) }).safeParse(process.env);
  if (!parsed.success) {
    throw new Error("NEAR_AI_API_KEY is missing in Wrenai/.env");
  }
  const keys = parsed.data.NEAR_AI_API_KEY.split(",")
    .map((key) => key.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (keys.length === 0) {
    throw new Error("NEAR_AI_API_KEY is empty in Wrenai/.env");
  }
  return keys;
}
