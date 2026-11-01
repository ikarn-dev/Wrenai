import type { Notice } from "@/components/ui/status-line";
import { confirmDelegation, confirmRevocation, prepareDelegation } from "@/server/delegation/actions";
import { INTENTS_CONTRACT_ID } from "@/shared/intents";
import { walletForAccount } from "./near-connector";
import {
  attempt,
  failureNotice,
  requestFailed,
  TRANSACTION_FAILED,
  type WalletFlow,
  walletNotice,
} from "./notices";

type KeyMethod = "add_public_key" | "remove_public_key";

// The Verifier's key methods require exactly 1 yoctoNEAR attached. Function-call keys can't attach a deposit, so
// only the account's full-access key, in the user's wallet, can approve the call.
const ONE_YOCTO = "1";
// 30 Tgas, NEAR CLI's default for a function call. Unused gas is refunded.
const KEY_CALL_GAS = "30000000000000";

/** Called with a short label each time the flow waits on something new. */
type ShowProgress = (label: string) => void;

// Wallet replies are untrusted, so this only shapes the message; the server reads the chain itself.
function failedOnChain(outcome: unknown): boolean {
  if (typeof outcome !== "object" || outcome === null || !("status" in outcome)) {
    return false;
  }
  // NEAR reports either { Failure: … } or, in the basic form, the string "Failure".
  const { status } = outcome;
  return status === "Failure" || (typeof status === "object" && status !== null && "Failure" in status);
}

async function sendKeyCall(
  method: KeyMethod,
  accountId: string,
  publicKey: string,
  flow: WalletFlow,
  show: ShowProgress,
): Promise<Notice | null> {
  const wallet = await walletForAccount(accountId, flow, () => show("Choose a wallet"));
  if (!wallet.ok) {
    return wallet.notice;
  }
  show("Check your wallet");
  const outcome = await attempt(
    () =>
      wallet.value.signAndSendTransaction({
        signerId: accountId,
        receiverId: INTENTS_CONTRACT_ID,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: method,
              args: { public_key: publicKey },
              gas: KEY_CALL_GAS,
              deposit: ONE_YOCTO,
            },
          },
        ],
      }),
    (error) => walletNotice(error, flow),
  );
  if (!outcome.ok) {
    return outcome.notice;
  }
  return failedOnChain(outcome.value) ? TRANSACTION_FAILED : null;
}

/**
 * Registers the user's agent key on intents.near from their wallet (Spec §3). Null means it is active: the confirm
 * action has already refreshed the page to show it.
 */
export async function authorizeAgentKey(accountId: string, show: ShowProgress): Promise<Notice | null> {
  const prepared = await attempt(prepareDelegation, () => requestFailed("authorize"));
  if (!prepared.ok) {
    return prepared.notice;
  }
  if (!prepared.value.ok) {
    return failureNotice(prepared.value);
  }
  if (prepared.value.kind === "active") {
    return null;
  }
  const sent = await sendKeyCall("add_public_key", accountId, prepared.value.publicKey, "authorize", show);
  if (sent !== null) {
    return sent;
  }
  show("Confirming…");
  const confirmed = await attempt(confirmDelegation, () => requestFailed("authorize"));
  if (!confirmed.ok) {
    return confirmed.notice;
  }
  return confirmed.value.ok ? null : failureNotice(confirmed.value);
}

/** Removes the agent key from intents.near from the user's wallet. Null means it is gone and the page refreshed. */
export async function revokeAgentKey(
  accountId: string,
  publicKey: string,
  show: ShowProgress,
): Promise<Notice | null> {
  const sent = await sendKeyCall("remove_public_key", accountId, publicKey, "revoke", show);
  if (sent !== null) {
    return sent;
  }
  show("Confirming…");
  const confirmed = await attempt(confirmRevocation, () => requestFailed("revoke"));
  if (!confirmed.ok) {
    return confirmed.notice;
  }
  return confirmed.value.ok ? null : failureNotice(confirmed.value);
}
