import { beforeEach, describe, expect, it, vi } from "vitest";
import { appActivityPage } from "@/server/activity/queries";
import { readActivityPage } from "@/server/activity/service";
import { walletActivityPage } from "@/server/activity/wallet";
import { database } from "@/server/db/client";
import { ACTIVITY_PAGE_SIZE, type ActivityEntry, type WalletActivityStream } from "@/shared/activity";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/client", () => ({ database: () => ({}) }));
vi.mock("@/server/activity/queries", () => ({ appActivityPage: vi.fn() }));
vi.mock("@/server/activity/wallet", () => ({ walletActivityPage: vi.fn() }));
const snapshot = 1_793_000_000_000;
const owner = { id: "owner", accountId: "owner.near" };
function item(id: string, at: number, source: "wallet" | "agents" = "wallet"): ActivityEntry {
  return {
    id,
    occurredAt: at,
    source,
    category: source === "wallet" ? "wallet" : "agent",
    title: "Test activity",
    description: "",
    status: "recorded",
    agent: null,
    transactionHash: null,
    amount: null,
  };
}

describe("combined account activity pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(appActivityPage).mockResolvedValue([]);
    vi.mocked(walletActivityPage).mockResolvedValue({ items: [], total: 0, next: null });
  });
  it("merges partial source pages without losing or duplicating tied events", async () => {
    const sources: Readonly<Record<WalletActivityStream, readonly ActivityEntry[]>> = {
      transactions: Array.from({ length: 22 }, (_, i) => item(`tx-${i}`, snapshot - 100)),
      tokens: Array.from({ length: 3 }, (_, i) => item(`ft-${i}`, snapshot - 10)),
      nfts: [],
      intents: [],
    };
    vi.mocked(walletActivityPage).mockImplementation(async (_owner, stream, position) => {
      const source = sources[stream];
      const start = position.next === "page-2" ? 20 : 0;
      const page = source.slice(start, start + ACTIVITY_PAGE_SIZE);
      return {
        items: page.slice(position.offset),
        total: page.length,
        next: source.length > start + 20 ? "page-2" : null,
      };
    });
    const events = Array.from({ length: 4 }, (_, i) => item(`app-${i}`, snapshot - 50 - i, "agents"));
    vi.mocked(appActivityPage).mockImplementation(async (_db, _owner, cursor) =>
      events.filter((row) => cursor.app.before === null || row.occurredAt < cursor.app.before.at),
    );
    const first = await readActivityPage(database(), owner, "all", null, snapshot);
    expect(first.items).toHaveLength(20);
    expect(first.items.slice(0, 3).map((row) => row.id)).toEqual(["ft-0", "ft-1", "ft-2"]);
    expect(first.nextCursor?.wallet.transactions.offset).toBe(13);
    const second = await readActivityPage(database(), owner, "all", first.nextCursor, snapshot);
    expect(second.items.map((row) => row.id)).toEqual(Array.from({ length: 7 }, (_, i) => `tx-${i + 13}`));
    const third = await readActivityPage(database(), owner, "all", second.nextCursor, snapshot);
    expect(third.items.map((row) => row.id)).toEqual(["tx-20", "tx-21"]);
    expect(third.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items, ...third.items].map((row) => row.id)).size).toBe(29);
  });
  it("keeps app history visible through an indexer outage and reports the missing sources", async () => {
    vi.mocked(appActivityPage).mockResolvedValue([item("agent-event", snapshot - 1, "agents")]);
    vi.mocked(walletActivityPage).mockRejectedValue(new Error("Indexer offline"));
    const result = await readActivityPage(database(), owner, "all", null, snapshot);
    expect(result.items.map((row) => row.id)).toEqual(["agent-event"]);
    expect(result.unavailable).toEqual([
      "Wallet transactions",
      "Token transfers",
      "NFT transfers",
      "Intents transfers",
    ]);
    expect(result.nextCursor).toBeNull();
  });
  it("avoids unrelated reads for filtered views and rejects cross-owner cursors before I/O", async () => {
    await readActivityPage(database(), owner, "agents", null, snapshot);
    expect(walletActivityPage).not.toHaveBeenCalled();
    vi.clearAllMocks();
    vi.mocked(walletActivityPage).mockResolvedValue({
      items: [item("tx", snapshot - 1)],
      total: 1,
      next: "more",
    });
    const page = await readActivityPage(database(), owner, "wallet", null, snapshot);
    expect(appActivityPage).not.toHaveBeenCalled();
    vi.clearAllMocks();
    await expect(
      readActivityPage(
        database(),
        { id: "stranger", accountId: "stranger.near" },
        "wallet",
        page.nextCursor,
        snapshot,
      ),
    ).rejects.toThrow();
    expect(walletActivityPage).not.toHaveBeenCalled();
  });
  it("does not display a database outage as an empty agent history", async () => {
    vi.mocked(appActivityPage).mockRejectedValue(new Error("database offline"));
    const result = await readActivityPage(database(), owner, "agents", null, snapshot);
    expect(result.items).toEqual([]);
    expect(result.unavailable).toEqual(["Agent activity"]);
  });
});
