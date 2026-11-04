import "server-only";
import { z } from "zod";
import { callViewFunction } from "@/server/near/rpc";
import { intentTokens } from "@/server/research/intents";
import type { TokenIcons } from "@/shared/market-pages";

// NEP-148 token icons, read from each NEAR token's ft_metadata. Only inline data:image URIs are kept: they need no
// network request in the browser and can't change after review. Kept for an hour per process.
const TTL_MS = 60 * 60_000;
const MAX_ICON_CHARS = 12_000;
const BATCH = 8;
const iconSchema = z
  .string()
  .max(MAX_ICON_CHARS)
  .regex(/^data:image\/(?:svg\+xml|png|jpeg|webp|gif)[;,]/);

let cached: { readonly at: number; readonly icons: ReadonlyMap<string, string> } | null = null;
let loading: Promise<ReadonlyMap<string, string>> | null = null;

async function readIcon(contract: string): Promise<string | null> {
  try {
    const { value } = await callViewFunction(contract, "ft_metadata", {});
    const icon = z.object({ icon: z.string().nullish() }).parse(value).icon;
    const parsed = iconSchema.safeParse(icon);
    return parsed.success ? parsed.data : null;
  } catch {
    // A token without readable metadata shows its letter mark instead; nothing depends on the icon.
    return null;
  }
}

async function loadIcons(contracts: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const icons = new Map<string, string>();
  for (let start = 0; start < contracts.length; start += BATCH) {
    const batch = contracts.slice(start, start + BATCH);
    const results = await Promise.all(batch.map(readIcon));
    batch.forEach((contract, index) => {
      const icon = results[index];
      if (icon) {
        icons.set(contract, icon);
      }
    });
  }
  return icons;
}

async function iconsByContract(contracts: readonly string[]): Promise<ReadonlyMap<string, string>> {
  if (cached && Date.now() - cached.at < TTL_MS) {
    return cached.icons;
  }
  loading ??= loadIcons(contracts)
    .then((icons) => {
      cached = { at: Date.now(), icons };
      return icons;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Icons for every NEAR token 1Click lists, by asset ID; one load an hour per process. */
export async function spotTokenIcons(): Promise<TokenIcons> {
  const contracts = (await intentTokens()).tokens.flatMap((t) =>
    t.blockchain === "near" && /^nep141:[a-z0-9._-]+$/.test(t.assetId) ? [t.assetId.slice(7)] : [],
  );
  const icons = await iconsByContract(contracts);
  return Object.fromEntries([...icons].map(([contract, icon]) => [`nep141:${contract}`, icon]));
}
