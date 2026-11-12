// Reviewed guest policy. Both networks are always available; these limits never authorize mainnet spending.
export const TESTNET_POLICY = {
  TESTNET_RPC_URL: "https://rpc.testnet.fastnear.com",
  TESTNET_MAX_GUESTS_PER_DAY: 10,
  TESTNET_MAX_ACTIONS_PER_GUEST: 10,
  TESTNET_MAX_ACTIONS_PER_DAY: 30,
  TESTNET_MAX_AGENTS_PER_GUEST: 5,
  TESTNET_GUEST_TTL_HOURS: 2,
  reserve: 10n ** 24n,
} as const;

export const GUEST_GRANTS: Readonly<Record<string, string>> = {
  "native:near": "0.1",
  "nep141:usdc.tidepool-sandbox.testnet": "5",
  "nep141:usdt.tidepool-sandbox.testnet": "5",
};

export const ACTION_CAPS: Readonly<Record<string, string>> = {
  "native:near": "0.01",
  "nep141:usdc.tidepool-sandbox.testnet": "1",
  "nep141:usdt.tidepool-sandbox.testnet": "1",
  "nep141:wnear.tidepool-sandbox.testnet": "0.25",
  "nep141:wbtc.tidepool-sandbox.testnet": "0.00001",
  "nep141:eth.tidepool-sandbox.testnet": "0.0003",
  "nep141:xaut.tidepool-sandbox.testnet": "0.001",
};
