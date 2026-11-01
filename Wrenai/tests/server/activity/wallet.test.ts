import { beforeEach, describe, expect, it, vi } from "vitest";
import { walletActivityPage } from "@/server/activity/wallet";
import { marketJson } from "@/server/research/market-http";

vi.mock("server-only", () => ({}));
vi.mock("@/server/research/market-http", () => ({ marketJson: vi.fn() }));
const snapshot = 1_793_000_000_000;
const hash = "H".repeat(44);
const position = { next: null, offset: 0, done: false, unavailable: false } as const;
const block = { block_timestamp: (BigInt(snapshot - 1) * 1_000_000n + 123n).toString() };
function native() {
  return {
    transaction_hash: hash,
    signer_account_id: "owner.near",
    receiver_account_id: "friend.near",
    block,
    actions: [{ action: "TRANSFER" }],
    actions_agg: { deposit: "1000000000000000000000001" },
    outcomes: { status: true },
  };
}
function token() {
  return {
    affected_account_id: "owner.near",
    involved_account_id: "friend.near",
    contract_account_id: "wrap.near",
    delta_amount: "-999999999999999999999999",
    event_index: "2",
    receipt_id: hash,
    transaction_hash: hash,
    block,
    cause: "TRANSFER",
    meta: { symbol: "wNEAR", decimals: "24" },
  };
}
function respond(data: readonly unknown[], next?: string): void {
  vi.mocked(marketJson).mockResolvedValue({
    value: { data, meta: { next_page: next } },
    capturedAt: snapshot,
  });
}

describe("public wallet activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEARBLOCKS_API_KEY", "");
  });
  it("preserves yocto precision and follows opaque v3 cursors inside the pinned snapshot", async () => {
    const cursor = "opaque/+=?cursor";
    respond([native()], "next-provider-cursor");
    const page = await walletActivityPage(
      "owner.near",
      "transactions",
      { ...position, next: cursor },
      snapshot,
    );
    expect(page.items[0]).toMatchObject({
      status: "completed",
      occurredAt: snapshot - 1,
      amount: { units: "1000000000000000000000001", direction: "out", decimals: 24 },
    });
    const request = new URL(vi.mocked(marketJson).mock.calls[0]?.[1] ?? "");
    expect(request.pathname).toBe("/v3/accounts/owner.near/txns");
    expect(request.searchParams.get("before_ts")).toBe("1793000000000000000");
    expect(request.searchParams.get("next")).toBe(cursor);
    expect(page.next).toBe("next-provider-cursor");
  });
  it("does not describe failed deposits or function-call deposits as transferred funds", async () => {
    respond([{ ...native(), outcomes: { status: false } }]);
    expect(
      (await walletActivityPage("owner.near", "transactions", position, snapshot)).items[0],
    ).toMatchObject({ status: "failed", amount: null });
    respond([{ ...native(), actions: [{ action: "FUNCTION_CALL", method: "swap" }] }]);
    expect(
      (await walletActivityPage("owner.near", "transactions", position, snapshot)).items[0],
    ).toMatchObject({ title: "Contract call", amount: null });
  });
  it("uses transfer direction and verified decimals without returning remote icons", async () => {
    respond([
      { ...token(), meta: { symbol: "wNEAR", decimals: "24", icon: "https://untrusted.example/icon.svg" } },
    ]);
    const page = await walletActivityPage("owner.near", "tokens", position, snapshot);
    expect(page.items[0]).toMatchObject({
      title: "Token sent",
      status: "recorded",
      amount: { units: "999999999999999999999999", decimals: 24, direction: "out" },
    });
    expect(JSON.stringify(page)).not.toContain("untrusted");
    respond([{ ...token(), meta: null }]);
    expect(
      (await walletActivityPage("owner.near", "tokens", position, snapshot)).items[0]?.amount,
    ).toMatchObject({ decimals: null, symbol: "Token" });
  });
  it("normalizes NFT and public NEP-245 Intents records separately", async () => {
    respond([{ ...token(), delta_amount: "1", token_id: "collectible-1", meta: { symbol: "COLLECTIBLE" } }]);
    expect((await walletActivityPage("owner.near", "nfts", position, snapshot)).items[0]).toMatchObject({
      title: "NFT received",
      amount: { symbol: "NFT", decimals: 0, units: "1" },
    });
    respond([
      {
        ...token(),
        contract_account_id: "intents.near",
        delta_amount: "1234567",
        token_id: "nep141:usdc.near",
        base_meta: { symbol: "USDC", decimals: "6" },
        meta: { spec: "mt-1.0.0" },
      },
    ]);
    expect((await walletActivityPage("owner.near", "intents", position, snapshot)).items[0]).toMatchObject({
      title: "Intents token received",
      amount: { symbol: "USDC", decimals: 6 },
    });
  });
  it("rejects unrelated accounts, future rows, invalid amounts and looping pagination", async () => {
    respond([{ ...native(), signer_account_id: "other.near" }]);
    await expect(walletActivityPage("owner.near", "transactions", position, snapshot)).rejects.toThrow();
    respond([{ ...native(), block: { block_timestamp: (BigInt(snapshot) * 1_000_000n).toString() } }]);
    await expect(walletActivityPage("owner.near", "transactions", position, snapshot)).rejects.toThrow();
    respond([{ ...token(), delta_amount: "1e18" }]);
    await expect(walletActivityPage("owner.near", "tokens", position, snapshot)).rejects.toThrow();
    respond([], "same");
    await expect(
      walletActivityPage("owner.near", "tokens", { ...position, next: "same" }, snapshot),
    ).rejects.toThrow();
  });
});
