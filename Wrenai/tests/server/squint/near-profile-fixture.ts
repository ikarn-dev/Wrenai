export const blockHash = "A".repeat(44);
export const poolId = "fixture.nearlytrade.near|wrap.near|10000";
export const lptId = `${poolId}#1`;
export function contractControlFixture(account: string): {
  codeHash: string;
  globalCodeHash: string | null;
  globalCodeAccount: string | null;
  blockHash: string;
  blockHeight: number;
  keys: readonly unknown[];
} {
  return {
    codeHash:
      account === "nearlytrade.near"
        ? "9mwfrbtBbDr3y2t9rHY944qAQTU2PsB5smqsAHZJo4G5"
        : account === "lock_8.nearlytrade.near"
          ? "4CMfhWsUNfXgotni5nnt9vePC1dpb4aQF8x1KQjoyG6u"
          : "1".repeat(32),
    globalCodeHash:
      account === "fixture.nearlytrade.near" ? "54GH1DmZgArERRH2ed8zJBXT7UxdeumaZe8Du8dtYJrt" : null,
    globalCodeAccount: null,
    blockHash,
    blockHeight: 123,
    keys: [],
  };
}
export function profileViewFixture(method: string, now: number): unknown {
  switch (method) {
    case "get_launch_by_token":
      return {
        id: 3000,
        token: "fixture.nearlytrade.near",
        creator: "creator.near",
        created_at_ms: now - 120000,
        total_supply: "1000000000000000000000000000",
        pool_id: poolId,
        lpt_id: lptId,
        step: "Done",
        inflight: false,
        quote: "wrap.near",
        left_point: 200,
        right_point: 500000,
      };
    case "get_locker_for":
      return "lock_8.nearlytrade.near";
    case "get_dcl_for":
    case "get_dcl":
      return "dclv2.ref-labs.near";
    case "ft_metadata":
      return { spec: "ft-1.0.0", decimals: 18 };
    case "ft_total_supply":
      return "1000000000000000000000000000";
    case "get_rules":
      return null;
    case "get_pool":
      return {
        pool_id: poolId,
        token_x: "fixture.nearlytrade.near",
        token_y: "wrap.near",
        state: "Running",
        total_x: "1000000000000000000000000",
        total_y: "1000000000000000000000000000",
        total_liquidity: "500000",
        whitelist: null,
        tax: null,
      };
    case "get_liquidity":
      return {
        lpt_id: lptId,
        owner_id: "lock_8.nearlytrade.near",
        pool_id: poolId,
        left_point: 200,
        right_point: 500000,
        amount: "500000",
        mft_id: "",
      };
    case "get_position":
      return { lpt_id: lptId, refunded: false };
    default:
      throw new Error(`Unrecognized profile fixture method ${method}`);
  }
}
