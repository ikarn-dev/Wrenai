import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { marketJson } from "@/server/research/market-http";
import {
  ACTIVITY_PAGE_SIZE,
  type ActivityEntry,
  type WalletActivityPosition,
  type WalletActivityStream,
} from "@/shared/activity";
import { MAX_TOKEN_UNITS, tokenUnitsSchema } from "@/shared/token-units";

const endpoints = { transactions: "txns", tokens: "ft-txns", nfts: "nft-txns", intents: "mt-txns" } as const;
const account = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
const hash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/);
const integer = z
  .union([z.string().regex(/^\d{1,80}$/), z.number().int().nonnegative().safe()])
  .transform(String);
const block = z.object({ block_timestamp: z.string().regex(/^\d{19}$/) });
const metadata = z
  .object({
    symbol: z.string().max(128).nullish(),
    decimals: z.coerce.number().int().min(0).max(36).nullish(),
  })
  .nullish();
const transfer = z.object({
  affected_account_id: z.string().max(128),
  involved_account_id: z.string().max(128).nullable(),
  contract_account_id: account,
  delta_amount: z.string().regex(/^-?(?:0|[1-9]\d{0,77})$/),
  event_index: integer,
  receipt_id: hash,
  transaction_hash: hash,
  block,
  cause: z.string().max(64),
  meta: metadata,
  base_meta: metadata,
  token_id: z.string().max(2000).optional(),
});
const transaction = z.object({
  transaction_hash: hash,
  signer_account_id: account,
  receiver_account_id: account,
  block,
  actions: z
    .array(z.object({ action: z.string().max(64), method: z.string().max(128).nullish() }))
    .min(1)
    .max(100),
  actions_agg: z.object({ deposit: tokenUnitsSchema }),
  outcomes: z.object({ status: z.boolean().nullable() }),
});
const envelope = z.object({
  data: z.array(z.unknown()).max(ACTIVITY_PAGE_SIZE),
  meta: z.object({ next_page: z.string().min(1).max(8192).nullish() }).optional(),
  errors: z.array(z.unknown()).optional(),
});
export interface WalletActivityPage {
  readonly items: readonly ActivityEntry[];
  readonly next: string | null;
  readonly total: number;
}

function eventTime(raw: string, snapshotAt: number): number {
  const nanos = BigInt(raw);
  if (nanos >= BigInt(snapshotAt) * 1_000_000n) {
    throw new Error("Wallet history exceeded its snapshot boundary");
  }
  return Number(nanos / 1_000_000n);
}

function nativeEntry(raw: unknown, owner: string, snapshotAt: number): ActivityEntry {
  const row = transaction.parse(raw);
  if (row.signer_account_id !== owner && row.receiver_account_id !== owner) {
    throw new Error("Unrelated wallet transaction");
  }
  const sent = row.signer_account_id === owner;
  const self = row.signer_account_id === row.receiver_account_id;
  const isTransfer = row.actions.length === 1 && row.actions[0]?.action === "TRANSFER";
  const method = row.actions.find((action) => action.method)?.method;
  const title = isTransfer
    ? self
      ? "Wallet transfer"
      : sent
        ? "NEAR sent"
        : "NEAR received"
    : method
      ? "Contract call"
      : "Wallet transaction";
  return {
    id: `wallet-tx:${row.transaction_hash}`,
    source: "wallet",
    category: "wallet",
    title,
    description: `${sent ? "To" : "From"} ${sent ? row.receiver_account_id : row.signer_account_id}${method ? ` · ${method}` : ""}`,
    status: row.outcomes.status === null ? "pending" : row.outcomes.status ? "completed" : "failed",
    occurredAt: eventTime(row.block.block_timestamp, snapshotAt),
    agent: null,
    transactionHash: row.transaction_hash,
    amount:
      isTransfer && !self && row.outcomes.status === true
        ? {
            kind: "token",
            units: row.actions_agg.deposit,
            decimals: 24,
            symbol: "NEAR",
            assetId: "native:near",
            direction: sent ? "out" : "in",
          }
        : null,
  };
}

function transferEntry(
  raw: unknown,
  stream: WalletActivityStream,
  owner: string,
  snapshotAt: number,
): ActivityEntry {
  const row = transfer.parse(raw);
  if (row.affected_account_id !== owner && row.involved_account_id !== owner) {
    throw new Error("Unrelated wallet token event");
  }
  const value = BigInt(row.delta_amount) * (row.affected_account_id === owner ? 1n : -1n);
  const units = value < 0n ? -value : value;
  if (units > MAX_TOKEN_UNITS) {
    throw new Error("Wallet token amount exceeded its bound");
  }
  const meta = stream === "intents" ? row.base_meta : row.meta;
  const symbol =
    stream === "nfts"
      ? "NFT"
      : meta?.symbol && /^[A-Za-z0-9._-]{1,24}$/.test(meta.symbol)
        ? meta.symbol
        : "Token";
  const asset =
    stream === "nfts"
      ? "NFT"
      : stream === "intents" && row.contract_account_id === "intents.near"
        ? "Intents token"
        : "Token";
  const counterpart = row.affected_account_id === owner ? row.involved_account_id : row.affected_account_id;
  const id = createHash("sha256")
    .update(
      JSON.stringify([
        stream,
        row.receipt_id,
        row.event_index,
        row.affected_account_id,
        row.contract_account_id,
        row.token_id ?? null,
      ]),
    )
    .digest("hex");
  return {
    id: `wallet-${stream}:${id}`,
    source: "wallet",
    category: "wallet",
    title: `${asset} ${value > 0n ? "received" : value < 0n ? "sent" : "activity"}`,
    description: `${counterpart ? `${value > 0n ? "From" : "To"} ${counterpart} · ` : ""}${row.contract_account_id}${stream === "nfts" && row.token_id ? ` · #${row.token_id.slice(0, 100)}` : ""}`,
    status: "recorded",
    occurredAt: eventTime(row.block.block_timestamp, snapshotAt),
    agent: null,
    transactionHash: row.transaction_hash,
    amount: {
      kind: "token",
      units: units.toString(),
      decimals: stream === "nfts" ? 0 : (meta?.decimals ?? null),
      symbol,
      ...(stream === "tokens" ? { assetId: `nep141:${row.contract_account_id}` } : {}),
      direction: value > 0n ? "in" : value < 0n ? "out" : "none",
    },
  };
}

/** Fixed, public NEAR history only. Provider cursors remain opaque and no remote images or arguments are fetched. */
export async function walletActivityPage(
  owner: string,
  stream: WalletActivityStream,
  position: WalletActivityPosition,
  snapshotAt: number,
  signal?: AbortSignal,
): Promise<WalletActivityPage> {
  account.parse(owner);
  const url = new URL(
    `https://api.nearblocks.io/v3/accounts/${encodeURIComponent(owner)}/${endpoints[stream]}`,
  );
  url.searchParams.set("limit", String(ACTIVITY_PAGE_SIZE));
  url.searchParams.set("before_ts", (BigInt(snapshotAt) * 1_000_000n).toString());
  if (position.next !== null) {
    url.searchParams.set("next", position.next);
  }
  const { NEARBLOCKS_API_KEY } = process.env;
  const response = await marketJson("NearBlocks wallet history", url.toString(), {
    cacheMs: 30_000,
    ...(signal ? { signal } : {}),
    ...(NEARBLOCKS_API_KEY
      ? {
          headers: {
            Authorization: `Bearer ${z.string().trim().min(1).max(8000).parse(NEARBLOCKS_API_KEY)}`,
          },
        }
      : {}),
  });
  const parsed = envelope.parse(response.value);
  if (parsed.errors?.length || (parsed.meta?.next_page && parsed.meta.next_page === position.next)) {
    throw new Error("Wallet indexer returned an invalid page");
  }
  const items = parsed.data.map((row) =>
    stream === "transactions"
      ? nativeEntry(row, owner, snapshotAt)
      : transferEntry(row, stream, owner, snapshotAt),
  );
  if (position.offset > items.length) {
    throw new Error("Wallet indexer cursor no longer matches its page");
  }
  if (items.some((item, index) => index > 0 && item.occurredAt > (items[index - 1]?.occurredAt ?? 0))) {
    throw new Error("Wallet indexer page is not ordered newest first");
  }
  return { items: items.slice(position.offset), total: items.length, next: parsed.meta?.next_page ?? null };
}
