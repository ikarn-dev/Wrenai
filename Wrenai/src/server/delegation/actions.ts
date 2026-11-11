"use server";

import { refresh } from "next/cache";
import { currentUser, type SessionUser } from "@/server/auth/session";
import { ExecutionError } from "@/server/execution/contracts";
import { consumeRateLimit } from "@/server/http/rate-limit";
import { NearRpcError, viewNearBalance } from "@/server/near/rpc";
import { ensureAgentKey, syncDelegatedKey } from "./delegated-key";

const ATTEMPTS_PER_WINDOW = 10;
const WINDOW_MS = 60_000;

export type DelegationErrorCode =
  | "signed_out"
  | "rate_limited"
  | "unavailable"
  | "near_rpc_unavailable"
  | "account_not_found"
  | "not_registered_yet"
  | "still_registered";

interface DelegationFailure {
  readonly ok: false;
  readonly code: DelegationErrorCode;
  readonly message: string;
}

export type PrepareDelegationResult =
  | { readonly ok: true; readonly kind: "register"; readonly publicKey: string }
  | { readonly ok: true; readonly kind: "active" }
  | DelegationFailure;

export type DelegationResult = { readonly ok: true } | DelegationFailure;

// One short line under the button: what happened, then what to do.
const MESSAGES: Readonly<Record<DelegationErrorCode, string>> = {
  signed_out: "Signed out. Sign in again.",
  rate_limited: "Too many attempts. Wait a minute.",
  unavailable: "Request protection is unavailable. Try again shortly.",
  near_rpc_unavailable: "Can't reach NEAR. Try again soon.",
  account_not_found: "Add NEAR to this account for gas first.",
  not_registered_yet: "Not on NEAR yet. Try again in a minute.",
  still_registered: "Still on NEAR. Try again in a minute.",
};

function failure(code: DelegationErrorCode): DelegationFailure {
  return { ok: false, code, message: MESSAGES[code] };
}

async function delegationUser(): Promise<SessionUser | DelegationFailure> {
  const user = await currentUser();
  if (user === null) {
    return failure("signed_out");
  }
  const decision = await consumeRateLimit(`delegation:${user.id}`, ATTEMPTS_PER_WINDOW, WINDOW_MS);
  if (decision !== "allowed") {
    return failure(decision === "limited" ? "rate_limited" : "unavailable");
  }
  return user;
}

async function withNear<T>(run: () => Promise<T>): Promise<T | DelegationFailure> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NearRpcError) {
      return failure("near_rpc_unavailable");
    }
    if (error instanceof ExecutionError) {
      return { ok: false, code: "unavailable", message: error.message };
    }
    throw error;
  }
}

/** Returns the agent key the wallet should register, creating it on first use. */
export async function prepareDelegation(): Promise<PrepareDelegationResult> {
  const user = await delegationUser();
  if ("ok" in user) {
    return user;
  }
  return withNear(async (): Promise<PrepareDelegationResult> => {
    const state = await syncDelegatedKey(user);
    if (state.kind === "active") {
      return { ok: true, kind: "active" };
    }
    // Registering is a transaction from the user's account, which must exist on chain to pay its gas.
    if ((await viewNearBalance(user.accountId)) === null) {
      return failure("account_not_found");
    }
    const publicKey = state.kind === "pending" ? state.publicKey : await ensureAgentKey(user.id);
    return { ok: true, kind: "register", publicKey };
  });
}

/** Call after the wallet sends `add_public_key`. Waits a few seconds for the key at final finality. */
export async function confirmDelegation(): Promise<DelegationResult> {
  const user = await delegationUser();
  if ("ok" in user) {
    return user;
  }
  return withNear(async (): Promise<DelegationResult> => {
    if ((await syncDelegatedKey(user, "registered")).kind !== "active") {
      return failure("not_registered_yet");
    }
    return { ok: true };
  });
}

/** Call after the wallet sends `remove_public_key`. The stored key and its secret go once NEAR shows it removed. */
export async function confirmRevocation(): Promise<DelegationResult> {
  const user = await delegationUser();
  if ("ok" in user) {
    return user;
  }
  return withNear(async (): Promise<DelegationResult> => {
    if ((await syncDelegatedKey(user, "removed")).kind === "active") {
      return failure("still_registered");
    }
    refresh();
    return { ok: true };
  });
}
