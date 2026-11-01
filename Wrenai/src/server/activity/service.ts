import "server-only";
import type { AppDatabase } from "@/server/db/client";
import {
  ACTIVITY_PAGE_SIZE,
  type ActivityCursor,
  type ActivityEntry,
  type ActivityFilter,
  type ActivityPage,
  WALLET_STREAMS,
  type WalletActivityPosition,
  type WalletActivityStream,
} from "@/shared/activity";
import { appActivityPage } from "./queries";
import { type WalletActivityPage, walletActivityPage } from "./wallet";

const sourceNames: Readonly<Record<WalletActivityStream, string>> = {
  transactions: "Wallet transactions",
  tokens: "Token transfers",
  nfts: "NFT transfers",
  intents: "Intents transfers",
};

function startCursor(ownerId: string, filter: ActivityFilter, now: number): ActivityCursor {
  const position = (): WalletActivityPosition => ({
    next: null,
    offset: 0,
    done: filter === "agents",
    unavailable: false,
  });
  return {
    format: 1,
    ownerId,
    filter,
    snapshotAt: now,
    app: { before: null, done: filter === "wallet", unavailable: false },
    wallet: { transactions: position(), tokens: position(), nfts: position(), intents: position() },
  };
}

function consumeWallet(
  position: WalletActivityPosition,
  page: WalletActivityPage,
  consumed: number,
): WalletActivityPosition {
  if (position.offset + consumed < page.total) {
    return { ...position, offset: position.offset + consumed };
  }
  return { next: page.next, offset: 0, done: page.next === null, unavailable: false };
}

/** Prefix consumption retains every source's ordering, including events sharing a millisecond. */
export async function readActivityPage(
  db: AppDatabase,
  owner: { readonly id: string; readonly accountId: string },
  filter: ActivityFilter,
  supplied: ActivityCursor | null,
  now = Date.now(),
): Promise<ActivityPage> {
  if (
    supplied &&
    (supplied.ownerId !== owner.id || supplied.filter !== filter || supplied.snapshotAt > now)
  ) {
    throw new Error("Activity cursor does not belong to this view");
  }
  const cursor = supplied ?? startCursor(owner.id, filter, now);
  const next: ActivityCursor = { ...cursor, app: { ...cursor.app }, wallet: { ...cursor.wallet } };
  const candidates: { readonly item: ActivityEntry; readonly stream: WalletActivityStream | "app" }[] = [];
  const [appResults, walletResults] = await Promise.all([
    Promise.allSettled([cursor.app.done ? Promise.resolve([]) : appActivityPage(db, owner.id, cursor)]),
    Promise.allSettled(
      WALLET_STREAMS.map(async (stream) => ({
        stream,
        page: cursor.wallet[stream].done
          ? null
          : await walletActivityPage(owner.accountId, stream, cursor.wallet[stream], cursor.snapshotAt),
      })),
    ),
  ]);
  // Keep the app read separate so a wallet indexer outage never hides agent history (and vice versa).
  const appResult = appResults[0];
  const appItems = appResult?.status === "fulfilled" ? appResult.value : null;
  if (appItems === null) {
    next.app = { ...next.app, done: true, unavailable: true };
  } else {
    for (const item of appItems.slice(0, ACTIVITY_PAGE_SIZE)) {
      candidates.push({ item, stream: "app" });
    }
  }
  const pages = new Map<WalletActivityStream, WalletActivityPage>();
  for (const [index, result] of walletResults.entries()) {
    const stream = WALLET_STREAMS[index];
    if (stream === undefined) {
      continue;
    }
    if (result.status === "rejected") {
      next.wallet[stream] = { ...cursor.wallet[stream], done: true, unavailable: true };
    } else if (result.value.page !== null) {
      pages.set(stream, result.value.page);
      for (const item of result.value.page.items) {
        candidates.push({ item, stream });
      }
    }
  }
  candidates.sort((a, b) => b.item.occurredAt - a.item.occurredAt);
  const selected = candidates.slice(0, ACTIVITY_PAGE_SIZE);
  const appSelected = selected.filter((row) => row.stream === "app");
  const lastApp = appSelected.at(-1)?.item;
  next.app = {
    ...next.app,
    before: lastApp ? { at: lastApp.occurredAt, id: lastApp.id } : next.app.before,
    done: next.app.done || (appItems !== null && appSelected.length === appItems.length),
  };
  for (const [stream, page] of pages) {
    next.wallet[stream] = consumeWallet(
      cursor.wallet[stream],
      page,
      selected.filter((row) => row.stream === stream).length,
    );
  }
  const unavailable = [
    ...(next.app.unavailable ? ["Agent activity"] : []),
    ...WALLET_STREAMS.filter((stream) => next.wallet[stream].unavailable).map(
      (stream) => sourceNames[stream],
    ),
  ];
  const done = next.app.done && WALLET_STREAMS.every((stream) => next.wallet[stream].done);
  return {
    items: selected.map((row) => row.item),
    nextCursor: done ? null : next,
    snapshotAt: cursor.snapshotAt,
    unavailable,
  };
}
