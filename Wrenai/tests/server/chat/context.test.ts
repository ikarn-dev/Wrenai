import { testDatabase } from "@tests/server/db/test-database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWalletAllocations } from "@/server/agents/token-budgets";
import { readChatContext } from "@/server/chat/context";
import { callViewFunction, viewNearBudgetBalance } from "@/server/near/rpc";
import { marketJson } from "@/server/research/market-http";
import { chatContextSchema } from "@/shared/chat";
import { WALLET_SWAP_USDC } from "@/shared/wallet-swap";

vi.mock("server-only", () => ({}));
vi.mock("@/server/agents/token-budgets", () => ({ readWalletAllocations: vi.fn() }));
vi.mock("@/server/near/rpc", () => ({
  callViewFunction: vi.fn(),
  viewNearBalance: vi.fn(),
  viewNearBudgetBalance: vi.fn(),
}));
vi.mock("@/server/research/market-http", () => ({ marketJson: vi.fn() }));

const user = { id: "owner", accountId: "owner.near" };
let store: Awaited<ReturnType<typeof testDatabase>>;

beforeEach(async () => {
  vi.resetAllMocks();
  store = await testDatabase();
  vi.mocked(viewNearBudgetBalance).mockResolvedValue({
    balance: 10n ** 24n,
    spendable: 95n * 10n ** 22n,
    blockHeight: 100,
  });
  vi.mocked(callViewFunction).mockImplementation(async (contract, method) => {
    const usdc = `nep141:${contract}` === WALLET_SWAP_USDC;
    return {
      blockHeight: 100,
      value:
        method === "ft_metadata"
          ? usdc
            ? { symbol: "USDC", decimals: 6 }
            : { symbol: "NEAR", decimals: 24 }
          : usdc
            ? "396272"
            : "0",
    };
  });
  vi.mocked(marketJson).mockRejectedValue(new Error("Token discovery unavailable"));
});

afterEach(async () => {
  await store.postgres.close();
});

describe("Jarvis wallet context", () => {
  it("includes directly verified USDC and subtracts reservations even if token discovery fails", async () => {
    vi.mocked(readWalletAllocations).mockResolvedValue((id) => (id === WALLET_SWAP_USDC ? 100_000n : 0n));
    const context = chatContextSchema.parse(await readChatContext(store.db, user));

    expect(context.walletHoldings).toMatchObject({
      coverage: "partial",
      tokens: [
        { assetId: "native:near", symbol: "NEAR", balance: "1", available: "0.95" },
        { assetId: WALLET_SWAP_USDC, symbol: "USDC", balance: "0.396272", available: "0.296272" },
        { symbol: "wNEAR", balance: "0", available: "0" },
      ],
    });
    expect(context.agents).toEqual([]);
  });

  it("keeps verified holdings visible when available amounts cannot be verified", async () => {
    vi.mocked(readWalletAllocations).mockRejectedValue(new Error("Allocations unavailable"));
    const context = await readChatContext(store.db, user);

    expect(context.walletHoldings?.tokens.find(({ assetId }) => assetId === WALLET_SWAP_USDC)).toMatchObject({
      balance: "0.396272",
      available: null,
    });
  });

  it("includes the entire verified inventory and an explicitly named contract missing from discovery", async () => {
    vi.mocked(readWalletAllocations).mockResolvedValue(() => 0n);
    vi.mocked(marketJson).mockResolvedValue({
      capturedAt: Date.now(),
      value: {
        account_id: user.accountId,
        tokens: Array.from({ length: 25 }, (_, index) => ({
          contract_id: `asset-${index}.near`,
          balance: "0",
        })),
      },
    });
    vi.mocked(callViewFunction).mockImplementation(async (_contract, method) => ({
      blockHeight: 100,
      value: method === "ft_metadata" ? { symbol: "TOKEN", decimals: 6 } : "2000000",
    }));

    const context = chatContextSchema.parse(
      await readChatContext(store.db, user, {
        message: "List my wallet tokens and check nep141:extra.near.",
      }),
    );
    expect(context.walletHoldings?.coverage).toBe("complete");
    expect(context.walletHoldings?.tokens).toHaveLength(29);
    expect(context.walletHoldings?.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assetId: "nep141:asset-24.near", balance: "2" }),
        expect.objectContaining({ assetId: "nep141:extra.near", balance: "2" }),
      ]),
    );
  });
});
