import type { Notice, NoticeTone } from "@/components/ui/status-line";
import type { ActionErrorCode } from "@/server/auth/actions";
import type { DelegationErrorCode } from "@/server/delegation/actions";
import { middleTruncate } from "@/shared/truncate";

export type WalletFlow = "sign_in" | "authorize" | "revoke";

/** A wallet flow's button state. While working, the label says what is happening (about 18 characters at most). */
export type FlowPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly label: string }
  | { readonly kind: "stopped"; readonly notice: Notice };

export type Step<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly notice: Notice };

export const WALLETS_UNAVAILABLE: Notice = { tone: "error", text: "Couldn't load wallets. Try again." };
export const TRANSACTION_FAILED: Notice = { tone: "error", text: "Transaction failed on NEAR. Try again." };
/** A page showed the recorded agent key because NEAR couldn't be reached to check it. */
export const KEY_NOT_CHECKED: Notice = {
  tone: "warn",
  text: "Can't reach NEAR to check your key. Reload to try again.",
};

const WALLET_FAILED: Notice = { tone: "error", text: "Wallet error. Try again." };

interface FlowText {
  readonly cancelled: string;
  readonly unsupported: string;
  readonly failed: string;
}

const NO_TRANSACTIONS = "This wallet can't send transactions. Try another.";

const FLOW_TEXT: Readonly<Record<WalletFlow, FlowText>> = {
  sign_in: {
    cancelled: "Sign-in cancelled.",
    unsupported: "This wallet can't sign in. Try another.",
    failed: "Sign-in failed. Try again.",
  },
  authorize: {
    cancelled: "Authorization cancelled.",
    unsupported: NO_TRANSACTIONS,
    failed: "Authorization failed. Try again.",
  },
  revoke: {
    cancelled: "Revoke cancelled.",
    unsupported: NO_TRANSACTIONS,
    failed: "Revoke failed. Try again.",
  },
};

// NEAR Connect and its wallets report a user's "no" as plain errors in their own words: "User rejected"
// (selector closed), "Wallet closed" (wallet frame closed), "Action was cancelled", Ledger's "denied by the user".
// Passkey prompts end with a DOMException named NotAllowedError or AbortError.
const CANCEL_WORDING = /cancel|reject|denied|declined|closed|dismiss/i;
const CANCEL_ERROR_NAMES: ReadonlySet<string> = new Set(["AbortError", "NotAllowedError"]);
// The wallet sandbox answers calls outside a wallet's manifest permissions with this text: a wallet fault, not a "no".
const SANDBOX_PERMISSION_DENIED = "Permission denied";
const UNSUPPORTED_WORDING = /method not found|not supported|unsupported/i;

/** Runs one step of a flow; a throw becomes that step's notice instead of escaping. */
export async function attempt<T>(
  run: () => Promise<T>,
  failure: (error: unknown) => Notice,
): Promise<Step<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, notice: failure(error) };
  }
}

/** A server action call that threw (network, server error) rather than returning a failure. */
export function requestFailed(flow: WalletFlow): Notice {
  return { tone: "error", text: FLOW_TEXT[flow].failed };
}

/** The wallet holds a different account than the one signed in. */
export function wrongAccountNotice(accountId: string): Notice {
  const name = accountId.length <= 24 ? accountId : middleTruncate(accountId, 6, 4);
  return { tone: "warn", text: `Switch your wallet to ${name}.` };
}

interface ErrorParts {
  readonly name: string;
  readonly message: string;
}

// Wallet failures cross an iframe boundary, so they arrive as Errors, strings or plain objects.
function errorParts(error: unknown): ErrorParts {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  if (typeof error === "string") {
    return { name: "", message: error };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return { name: "", message: error.message };
  }
  return { name: "", message: "" };
}

/** One short line for a failed wallet call. A cancellation stays neutral; a wallet fault reads as an error. */
export function walletNotice(error: unknown, flow: WalletFlow): Notice {
  const { name, message } = errorParts(error);
  if (message === SANDBOX_PERMISSION_DENIED) {
    return WALLET_FAILED;
  }
  if (CANCEL_ERROR_NAMES.has(name) || CANCEL_WORDING.test(message)) {
    return { tone: "info", text: FLOW_TEXT[flow].cancelled };
  }
  return UNSUPPORTED_WORDING.test(message)
    ? { tone: "warn", text: FLOW_TEXT[flow].unsupported }
    : WALLET_FAILED;
}

type ServerErrorCode = ActionErrorCode | DelegationErrorCode;

// Failures that clear by waiting or retrying are warnings; the rest need another wallet, key or account.
function failureTone(code: ServerErrorCode): NoticeTone {
  switch (code) {
    case "rate_limited":
    case "unavailable":
    case "challenge_invalid":
    case "near_rpc_unavailable":
    case "not_registered_yet":
    case "still_registered":
      return "warn";
    case "invalid_request":
    case "signature_invalid":
    case "key_not_full_access":
    case "signed_out":
    case "account_not_found":
      return "error";
    default: {
      const unhandled: never = code;
      throw new Error(`Unhandled server error code: ${String(unhandled)}`);
    }
  }
}

/** A failure a server action returned, with the message it chose. */
export function failureNotice(failure: { readonly code: ServerErrorCode; readonly message: string }): Notice {
  return { tone: failureTone(failure.code), text: failure.message };
}
