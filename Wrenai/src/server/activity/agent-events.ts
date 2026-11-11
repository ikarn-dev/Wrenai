import type { ActivityEntry } from "@/shared/activity";

// How each agent audit event reads in Activity: a short title, a one-line detail that fits the Details column
// (about 40 characters, so it never wraps or crowds the next column) and the lifecycle state shown as its badge.
// Phrased from the event kind rather than the stored audit sentence, so older rows read the same way. The stored
// message stays the full audit record; it's shown only where the kind carries a dynamic reason.

interface AgentEventView {
  readonly title: string;
  /** null keeps the stored message (its reason is specific to the event). */
  readonly detail: string | null;
  readonly status: ActivityEntry["status"];
}

const VIEWS: Readonly<Record<string, AgentEventView>> = {
  // Creation
  strategy_parsed: {
    title: "Strategy reviewed",
    detail: "Rules read by a verified model",
    status: "reviewed",
  },
  agent_creation_review: {
    title: "Agent created",
    detail: "Saved paused with its budget",
    status: "created",
  },
  strategy_saved: { title: "Strategy saved", detail: null, status: "saved" },
  cloned: { title: "Agent cloned", detail: "Strategy and limits copied", status: "created" },
  assets_reviewed: { title: "Assets reviewed", detail: "Strategy tokens checked", status: "reviewed" },
  capital_reviewed: { title: "Budget allocated", detail: "No funds were moved", status: "reviewed" },
  // Funding
  wallet_funding_delivered: { title: "Agent funded", detail: "Funds reached its balance", status: "funded" },
  wallet_funding_declined: {
    title: "Deposit cancelled",
    detail: "Declined in your wallet",
    status: "cancelled",
  },
  wallet_funding_discarded: {
    title: "Deposit discarded",
    detail: "Unfinished deposit removed",
    status: "cancelled",
  },
  native_funding_discarded: {
    title: "Deposit discarded",
    detail: "Unfinished deposit removed",
    status: "cancelled",
  },
  wallet_funding_refunded: {
    title: "Deposit refunded",
    detail: "Returned to your wallet",
    status: "refunded",
  },
  wallet_funding_kept_public: {
    title: "Funding kept public",
    detail: "Funds stay in public Intents",
    status: "recorded",
  },
  allocation_moved: { title: "Funds reassigned", detail: null, status: "recorded" },
  // Running
  runtime_requested: { title: "Agent starting", detail: "Trading checks starting", status: "started" },
  resume: { title: "Agent started", detail: "Waiting for the next check", status: "started" },
  pause: { title: "Agent paused", detail: "Positions kept", status: "paused" },
  stop: { title: "Agent stopped", detail: "Stopped by you", status: "stopped" },
  stopped: { title: "Agent stopped", detail: null, status: "stopped" },
  global_stop: { title: "All agents stopped", detail: "Global stop on", status: "stopped" },
  global_stop_cleared: { title: "Global stop cleared", detail: "Agents stay stopped", status: "recorded" },
  strategy_check_failed: { title: "Strategy check failed", detail: null, status: "failed" },
  runtime_failed: { title: "Agent blocked", detail: "Checks stopped, funds held", status: "failed" },
  // Deletion
  // Older delete requests returned funds themselves; since Nov 5 2026 a delete leaves them waiting in Claims.
  delete_requested: {
    title: "Delete requested",
    detail: "Funds it holds wait in Claims",
    status: "deleting",
  },
  claim_requested: {
    title: "Claiming funds",
    detail: "Stopped, sending funds to your wallet",
    status: "pending",
  },
  // The stored message says whether a return delivered anything (agent-return.ts → finishAgentClaim).
  claim: { title: "Funds claimed", detail: null, status: "completed" },
  perps_return_confirmed: {
    title: "Perps funds returned",
    detail: "Back in the private balance",
    status: "completed",
  },
  return_dust_released: {
    title: "Dust left on venue",
    detail: "Below the return minimum",
    status: "recorded",
  },
  delete: { title: "Agent deleted", detail: null, status: "deleted" },
  whale_alert: { title: "Watched wallet movement", detail: null, status: "recorded" },
};

/** The stored audit sentence as one short line: its first sentence, without the closing period. */
function firstSentence(message: string): string {
  const [first = ""] = message.split(/(?<=\.)\s/);
  return first.replace(/\.$/, "").slice(0, 160);
}

/**
 * An agent event's title, detail and lifecycle badge. Unknown kinds keep a generic title and the first sentence
 * of their stored message, so a new writer is never hidden.
 */
export function agentEventView(kind: string, message: string): AgentEventView {
  const view = VIEWS[kind];
  if (view === undefined) {
    return { title: "Agent updated", detail: firstSentence(message), status: "recorded" };
  }
  if (kind === "strategy_saved") {
    const version = /version (\d+)/.exec(message)?.[1];
    return { ...view, detail: version ? `Version ${version} saved, paused` : "Saved, paused" };
  }
  return { ...view, detail: view.detail ?? firstSentence(message) };
}

/** Workflow poll fences: internal markers for one polling segment, never user-facing events. */
export const POLL_FENCE_KINDS = ["agent_return_poll_%", "wallet_funding_poll_%"] as const;
