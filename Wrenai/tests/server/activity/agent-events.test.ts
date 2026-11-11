import { describe, expect, it } from "vitest";
import { agentEventView } from "@/server/activity/agent-events";

// Details must fit the Details column on one line (row.tsx truncates beyond about 46 characters).
const DETAIL_LIMIT = 40;
const LIFECYCLE: readonly (readonly [kind: string, message: string, title: string, status: string])[] = [
  [
    "agent_creation_review",
    "Created the reviewed agent and reserved its selected token budget.",
    "Agent created",
    "created",
  ],
  ["strategy_parsed", "Strategy parsed with a verified model response.", "Strategy reviewed", "reviewed"],
  ["strategy_saved", "Strategy version 3 saved. Agent paused.", "Strategy saved", "saved"],
  ["wallet_funding_delivered", "Funds arrived in the agent's private balance.", "Agent funded", "funded"],
  ["wallet_funding_declined", "The wallet deposit was cancelled.", "Deposit cancelled", "cancelled"],
  ["wallet_funding_discarded", "Unfinished deposit discarded.", "Deposit discarded", "cancelled"],
  ["resume", "Waiting for the next strategy check.", "Agent started", "started"],
  ["pause", "Paused by you. Existing positions are retained.", "Agent paused", "paused"],
  ["stopped", "Stopped by the global stop.", "Agent stopped", "stopped"],
  [
    "delete_requested",
    "Delete requested. Returning funds to your wallet first.",
    "Delete requested",
    "deleting",
  ],
  ["delete", "Funds returned to your wallet. Agent deleted, history retained.", "Agent deleted", "deleted"],
];

describe("agent event view", () => {
  it.each(LIFECYCLE)(
    "shows %s as a lifecycle badge with a one-line detail",
    (kind, message, title, status) => {
      const view = agentEventView(kind, message);
      expect(view).toMatchObject({ title, status });
      expect(view.detail).not.toContain("\n");
      expect(view.detail?.length ?? 0).toBeGreaterThan(0);
      expect(view.detail?.length ?? 0).toBeLessThanOrEqual(DETAIL_LIMIT);
    },
  );
  it("keeps the saved version from the stored message", () => {
    expect(agentEventView("strategy_saved", "Strategy version 12 saved. Agent paused.").detail).toBe(
      "Version 12 saved, paused",
    );
  });
  it("shows an unknown kind by the first sentence of its stored message", () => {
    expect(agentEventView("future_kind", "Something new happened. More context here.")).toEqual({
      title: "Agent updated",
      detail: "Something new happened",
      status: "recorded",
    });
  });
});
