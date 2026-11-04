import { hunterInstruction, memeAsset, reportFixture } from "@tests/server/squint/fixtures";
import {
  blockHash,
  contractControlFixture,
  profileViewFixture,
} from "@tests/server/squint/near-profile-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyMemeContract } from "@/server/squint/near-profile";

const io = vi.hoisted(() => ({ view: vi.fn(), control: vi.fn(), price: vi.fn(), time: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/near/rpc", () => ({
  callViewFunction: io.view,
  readContractControl: io.control,
  finalBlockTime: io.time,
}));
vi.mock("@/server/engine/instruction-price", () => ({ assetUsdPrice: io.price }));
const now = 1793788200000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.resetAllMocks();
  io.control.mockImplementation(async (account: string) => contractControlFixture(account));
  io.view.mockImplementation(async (_contract: string, method: string) => ({
    value: profileViewFixture(method, now),
    blockHash,
    blockHeight: 123,
  }));
  io.price.mockResolvedValue({ n: 2n, d: 1n, observedAt: now });
  io.time.mockResolvedValue(now - 1000);
});
afterEach(() => vi.useRealTimers());
const check = () => verifyMemeContract(reportFixture(now), memeAsset, hunterInstruction(now), "a".repeat(64));
describe("independent immutable-token and locked-liquidity profile", () => {
  it("binds factory, token, rules, supply and pool ownership at one final block", async () => {
    expect(await check()).toMatchObject({
      profile: "nearly-raw-v6-lock8",
      token: "fixture.nearlytrade.near",
      blockHash,
      blockHeight: 123,
      observedAt: now - 1000,
    });
    for (const args of io.view.mock.calls) {
      expect(args[4]).toBe(blockHash);
    }
    expect(io.control).toHaveBeenCalledWith("fixture.nearlytrade.near", blockHash);
    expect(io.control).toHaveBeenCalledWith("lock_8.nearlytrade.near", blockHash);
  });
  it.each(["code", "keys", "global-account"])(
    "rejects a clean provider score when independent token %s controls fail",
    async (kind) => {
      io.control.mockImplementation(async (account: string) => {
        const control = contractControlFixture(account);
        return account !== memeAsset.contractAddress
          ? control
          : kind === "code"
            ? { ...control, globalCodeHash: "B".repeat(44) }
            : kind === "keys"
              ? { ...control, keys: [{ public_key: "owner" }] }
              : { ...control, globalCodeAccount: "mutable.near" };
      });
      await expect(check()).rejects.toThrow("keyless");
    },
  );
  it.each([
    ["get_rules", { until_ms: String(now + 1) }, "restrictions"],
    ["get_locker_for", "unreviewed.near", "locker"],
    ["get_dcl_for", "another-dex.near", "exchange"],
    ["ft_total_supply", "1000000000000000000000000001", "supply"],
    [
      "get_liquidity",
      {
        lpt_id: "wrong",
        owner_id: "attacker.near",
        pool_id: "wrong",
        left_point: 200,
        right_point: 500000,
        amount: "500000",
        mft_id: "",
      },
      null,
    ],
    [
      "get_pool",
      {
        pool_id: "wrong",
        token_x: "fixture.nearlytrade.near",
        token_y: "wrap.near",
        state: "Running",
        total_x: "1",
        total_y: "1",
        total_liquidity: "500000",
        whitelist: null,
        tax: null,
      },
      "pool",
    ],
  ])("rejects unsupported or inconsistent %s evidence", async (method, value, message) => {
    io.view.mockImplementation(async (_contract: string, name: string) => ({
      value: name === method ? value : profileViewFixture(name, now),
      blockHash,
      blockHeight: 123,
    }));
    if (typeof message === "string") {
      await expect(check()).rejects.toThrow(message);
    } else {
      await expect(check()).rejects.toThrow();
    }
  });
  it("rejects a partial locked share and insufficient real quote-token reserves", async () => {
    io.view.mockImplementation(async (_contract: string, name: string) => ({
      value:
        name === "get_liquidity"
          ? {
              lpt_id: "fixture.nearlytrade.near|wrap.near|10000#1",
              owner_id: "lock_8.nearlytrade.near",
              pool_id: "fixture.nearlytrade.near|wrap.near|10000",
              left_point: 200,
              right_point: 500000,
              amount: "499999",
              mft_id: "",
            }
          : profileViewFixture(name, now),
      blockHash,
      blockHeight: 123,
    }));
    await expect(check()).rejects.toThrow("fully locked");
    io.view.mockImplementation(async (_contract: string, name: string) => ({
      value: profileViewFixture(name, now),
      blockHash,
      blockHeight: 123,
    }));
    await expect(
      verifyMemeContract(
        reportFixture(now),
        memeAsset,
        hunterInstruction(now, { minimumLiquidityUsd: "2000.000000000000000001" }),
        "a".repeat(64),
      ),
    ).rejects.toThrow("minimum");
  });
  it("does not accept stale chain time or USD liquidity evidence", async () => {
    io.time.mockResolvedValue(now - 15000);
    await expect(check()).rejects.toThrow("stale");
    io.time.mockResolvedValue(now);
    io.price.mockResolvedValue({ n: 2n, d: 1n, observedAt: now - 5000 });
    await expect(check()).rejects.toThrow("expired");
  });
  it("stops at incomplete holder evidence before spending any chain-read quota", async () => {
    const report = reportFixture(now, {
      coverage: { wallets_traced: 20, wallets_checked: 20, transfers_complete: false },
    });
    await expect(
      verifyMemeContract(report, memeAsset, hunterInstruction(now), "a".repeat(64)),
    ).rejects.toThrow("incomplete");
    expect(io.control).not.toHaveBeenCalled();
  });
});
