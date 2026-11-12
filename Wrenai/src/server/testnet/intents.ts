import "server-only";
import { z } from "zod";
import { TESTNET_ASSETS, type TestnetLocation, testnetAsset } from "@/shared/testnet";
import { tokenUnitsSchema } from "@/shared/token-units";
import { TestnetError } from "./config";
import { VERIFIER, verifierReady } from "./provider";
import { type TestnetCall, testnetBalance, testnetView } from "./rpc";

export async function publicIntentsBalances(account: string): Promise<ReadonlyMap<string, bigint>> {
  await verifierReady();
  const assets = TESTNET_ASSETS.filter((a) => a.contract !== null);
  const values = z
    .array(tokenUnitsSchema)
    .length(assets.length)
    .parse(
      await testnetView(VERIFIER, "mt_batch_balance_of", {
        account_id: account,
        token_ids: assets.map((a) => a.id),
      }),
    );
  return new Map(assets.map((a, i) => [a.id, BigInt(values[i] ?? "0")]));
}

export async function locatedBalance(
  account: string,
  asset: string,
  location: TestnetLocation,
): Promise<bigint> {
  if (location === "wallet") {
    return testnetBalance(account, asset);
  }
  if (!testnetAsset(asset).contract) {
    throw new TestnetError(
      "invalid_input",
      "Native NEAR is held in the wallet, not the public Intents balance.",
    );
  }
  return (await publicIntentsBalances(account)).get(asset) ?? 0n;
}

export async function publicIntentsTransfer(
  account: string,
  assetId: string,
  units: string,
  recipient: string,
): Promise<TestnetCall> {
  if (
    !testnetAsset(assetId).contract ||
    BigInt(tokenUnitsSchema.parse(units)) === 0n ||
    recipient === account
  ) {
    throw new TestnetError(
      "invalid_input",
      "Select a test token, positive amount and a different recipient.",
    );
  }
  await verifierReady();
  const enabled = z
    .boolean()
    .parse(await testnetView(VERIFIER, "is_auth_by_predecessor_id_enabled", { account_id: account }));
  if (!enabled) {
    throw new TestnetError("unauthorized", "Direct transfers are disabled for this public Intents account.");
  }
  // NEP-245 authenticates the transaction predecessor; no relay or extra off-chain key is required.
  return {
    receiverId: VERIFIER,
    method: "mt_transfer",
    deposit: "1",
    gas: "50000000000000",
    args: { receiver_id: recipient, token_id: assetId, amount: units },
  };
}
