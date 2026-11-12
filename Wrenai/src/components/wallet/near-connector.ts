import type { NearConnector, NearConnectorOptions, NearWalletBase } from "@hot-labs/near-connect";
import {
  attempt,
  type Step,
  WALLETS_UNAVAILABLE,
  type WalletFlow,
  walletNotice,
  wrongAccountNotice,
} from "./notices";

const connectorPromises: Partial<Record<"mainnet" | "testnet", Promise<NearConnector>>> = {};

// NEAR Connect runs each wallet's code in a sandboxed srcdoc iframe, which inherits this page's CSP, so its scripts
// need the page's nonce. Next puts the nonce on its own script tags, and the property stays readable after the
// browser hides the attribute. Reading it here keeps it right after client-side navigations.
function pageNonce(): string | undefined {
  const nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
  return nonce === undefined || nonce.length === 0 ? undefined : nonce;
}

function connectorOptions(network: "mainnet" | "testnet"): NearConnectorOptions {
  // Only wallets that can sign messages (sign-in) and send transactions (the agent key) are listed.
  const options: NearConnectorOptions = {
    network,
    features: {
      signMessage: true,
      signAndSendTransaction: true,
      ...(network === "testnet" ? { testnet: true } : {}),
    },
  };
  const nonce = pageNonce();
  return nonce === undefined ? options : { ...options, cspNonce: nonce };
}

/** Loaded on first use, so the wallet selector stays out of the initial bundle. */
export function nearConnector(network: "mainnet" | "testnet" = "mainnet"): Promise<NearConnector> {
  const existing = connectorPromises[network];
  if (existing) {
    return existing;
  }
  const promise = import("@hot-labs/near-connect")
    .then(({ NearConnector: Connector }) => new Connector(connectorOptions(network)))
    .catch((error: unknown) => {
      delete connectorPromises[network];
      throw error;
    });
  connectorPromises[network] = promise;
  return promise;
}

async function holdsAccount(wallet: NearWalletBase, accountId: string): Promise<boolean> {
  const accounts = await wallet.getAccounts();
  return accounts.some((account) => account.accountId === accountId);
}

// The wallet from an earlier sign-in, if it still holds this account. Any failure means there is none to reuse.
async function restoredWallet(connector: NearConnector, accountId: string): Promise<NearWalletBase | null> {
  try {
    const wallet = await connector.wallet();
    return (await holdsAccount(wallet, accountId)) ? wallet : null;
  } catch {
    // Not connected, or the session expired in the wallet: the user picks a wallet again.
    return null;
  }
}

/**
 * The wallet to send from: the connected one if it holds `accountId`, otherwise the one the user picks now.
 * It must be the signed-in account, because intents.near registers a key for whichever account sends the call.
 */
export async function walletForAccount(
  accountId: string,
  flow: WalletFlow,
  onPicking: () => void,
): Promise<Step<NearWalletBase>> {
  const connector = await attempt(nearConnector, () => WALLETS_UNAVAILABLE);
  if (!connector.ok) {
    return connector;
  }
  const restored = await restoredWallet(connector.value, accountId);
  if (restored !== null) {
    return { ok: true, value: restored };
  }
  onPicking();
  const onWalletError = (error: unknown) => walletNotice(error, flow);
  const walletId = await attempt(() => connector.value.selectWallet(), onWalletError);
  if (!walletId.ok) {
    return walletId;
  }
  const wallet = await attempt(() => connector.value.connect({ walletId: walletId.value }), onWalletError);
  if (!wallet.ok) {
    return wallet;
  }
  const holds = await attempt(() => holdsAccount(wallet.value, accountId), onWalletError);
  if (!holds.ok) {
    return holds;
  }
  return holds.value ? wallet : { ok: false, notice: wrongAccountNotice(accountId) };
}
