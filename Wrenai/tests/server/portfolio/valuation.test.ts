import { executionTestContext } from "@tests/server/execution/test-context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectedBalanceToken } from "@/server/execution/balance-session";
import { readHlAccount } from "@/server/execution/hyperliquid/account-state";
import { readPrivateBalances } from "@/server/execution/private-inventory";
import {
  balanceReferenceValue,
  readConnectedWalletValue,
  readPortfolioValuation,
} from "@/server/portfolio/valuation";
import { walletTokenHoldings } from "@/server/portfolio/wallet-tokens";
import type { IntentToken } from "@/server/research/intents";
import { intentTokens } from "@/server/research/intents";

vi.mock("server-only", () => ({}));
vi.mock("@/server/research/intents", () => ({ intentTokens: vi.fn() }));
vi.mock("@/server/portfolio/wallet-tokens", () => ({
  walletTokenHoldings: vi.fn(),
  WALLET_SCAN_TIMEOUT_MS: 15_000,
}));
vi.mock("@/server/execution/balance-session", () => ({ connectedBalanceToken: vi.fn() }));
vi.mock("@/server/execution/private-inventory", () => ({ readPrivateBalances: vi.fn() }));
vi.mock("@/server/execution/hyperliquid/account-state", async (original) => ({
  ...(await original<typeof import("@/server/execution/hyperliquid/account-state")>()),
  readHlAccount: vi.fn(),
}));
vi.mock("@/server/portfolio/public-intents", () => ({
  readPublicIntentsInventory: async () => ({ balances: [], complete: true, blockHeight: 1 }),
}));
const now = Date.now();
const usdc: IntentToken = {
  assetId: "nep141:usdc.near",
  blockchain: "near",
  decimals: 6,
  symbol: "USDC",
  price: "1.0000001",
  priceUpdatedAt: new Date(now).toISOString(),
};
const near: IntentToken = {
  assetId: "nep141:wrap.near",
  blockchain: "near",
  decimals: 24,
  symbol: "NEAR",
  price: "3.5",
  priceUpdatedAt: new Date(now).toISOString(),
};
let context: Awaited<ReturnType<typeof executionTestContext>> | null = null;
afterEach(async () => {
  vi.resetAllMocks();
  if (context) {
    await context.postgres.close();
    context = null;
  }
});
describe("portfolio display estimates without financial writes", () => {
  it("uses exact contract identities and floors fractional micro-dollars", () => {
    expect(
      balanceReferenceValue({ assetId: usdc.assetId, quantity: 1_000_001n, decimals: 6 }, [usdc], now),
    ).toBe(1_000_001n);
    expect(
      balanceReferenceValue({ assetId: "native:near", quantity: 10n ** 24n, decimals: 24 }, [near], now),
    ).toBe(3_500_000n);
    expect(
      balanceReferenceValue({ assetId: "nep141:fake-usdc.near", quantity: 1_000_000n }, [usdc], now),
    ).toBeNull();
  });
  it("does not turn missing, duplicate, stale or changed-precision prices into zero balances", () => {
    for (const candidates of [
      [],
      [usdc, usdc],
      [{ ...usdc, price: "0" }],
      [{ ...usdc, priceUpdatedAt: new Date(now - 120_000).toISOString() }],
      [{ ...usdc, priceUpdatedAt: new Date(now + 1001).toISOString() }],
    ]) {
      expect(
        balanceReferenceValue({ assetId: usdc.assetId, quantity: 1_000_000n }, candidates, now),
      ).toBeNull();
    }
    expect(
      balanceReferenceValue({ assetId: usdc.assetId, quantity: 1n, decimals: 24 }, [usdc], now),
    ).toBeNull();
    expect(balanceReferenceValue({ assetId: usdc.assetId, quantity: 0n }, [], now)).toBe(0n);
  });
  it("shows partial owner-scoped data when a location fails, without reading trading keys or treating holdings as PnL", async () => {
    context = await executionTestContext();
    vi.mocked(intentTokens).mockResolvedValue({
      tokens: [usdc, near],
      source: { id: "offline", label: "Offline registry", url: "https://example.test", observedAt: now },
    });
    vi.mocked(walletTokenHoldings).mockResolvedValue({
      tokens: [
        {
          assetId: "native:near",
          symbol: "NEAR",
          decimals: 24,
          balanceUnits: (10n ** 24n).toString(),
          spendableUnits: "0",
          blockHeight: 1,
          observedAt: now,
        },
      ],
      complete: true,
      note: "Offline wallet",
    });
    vi.mocked(connectedBalanceToken).mockResolvedValue("offline-session");
    vi.mocked(readPrivateBalances).mockRejectedValue(new Error("Offline provider unavailable"));
    const value = await readPortfolioValuation(context.db, { id: "stranger", accountId: "stranger.near" });
    expect(value.totalMicroUsd).toBeNull();
    expect(value.knownMicroUsd).toBe(3_500_000n);
    expect(value.locations.find((location) => location.id === "private")).toMatchObject({
      complete: false,
      knownMicroUsd: 0n,
    });
    expect(readHlAccount).not.toHaveBeenCalled();
    expect(walletTokenHoldings).toHaveBeenCalledWith("stranger.near");
  });

  it("values the connected wallet independently and retains balances when reference prices fail", async () => {
    vi.mocked(intentTokens).mockRejectedValue(new Error("Offline price registry"));
    vi.mocked(walletTokenHoldings).mockResolvedValue({
      tokens: [
        {
          assetId: usdc.assetId,
          symbol: "USDC",
          decimals: 6,
          balanceUnits: "396272",
          spendableUnits: "396272",
          blockHeight: 1,
          observedAt: now,
        },
      ],
      complete: true,
      note: "Offline wallet",
    });
    await expect(readConnectedWalletValue("owner.near", new AbortController().signal)).resolves.toMatchObject(
      {
        id: "wallet",
        complete: false,
        holdings: [{ assetId: usdc.assetId, quantity: 396272n, valueMicroUsd: null }],
      },
    );
    expect(connectedBalanceToken).not.toHaveBeenCalled();
    expect(readHlAccount).not.toHaveBeenCalled();
  });
});
