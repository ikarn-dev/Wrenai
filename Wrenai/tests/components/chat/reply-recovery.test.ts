import { describe, expect, it } from "vitest";
import { rejectOptimisticTurn } from "@/components/chat/reply-recovery";
import type { ChatTurn, Conversation } from "@/shared/chat";

const previous: ChatTurn = {
  id: crypto.randomUUID(),
  sequence: 1,
  message: "Earlier message",
  includeContext: true,
  state: "complete",
  reply: null,
  createdAt: 1000,
};
const pending: ChatTurn = {
  id: crypto.randomUUID(),
  sequence: 2,
  message: "Latest message",
  includeContext: true,
  state: "pending",
  reply: null,
  createdAt: 2000,
};
const conversation: Conversation = {
  id: crypto.randomUUID(),
  title: "Saved history",
  updatedAt: 2000,
  turns: [previous, pending],
  hasEarlier: true,
};

describe("rejected optimistic chat requests", () => {
  it("removes only the rejected placeholder and preserves the saved history without mutation", () => {
    const result = rejectOptimisticTurn(conversation, pending.id, undefined);
    expect(result).toEqual({ ...conversation, turns: [previous] });
    expect(conversation.turns).toEqual([previous, pending]);
  });
  it("restores the previous failed message when a retry is rejected", () => {
    const failed: ChatTurn = { ...pending, state: "failed", createdAt: 1500 };
    expect(rejectOptimisticTurn(conversation, pending.id, failed)?.turns).toEqual([previous, failed]);
  });
  it("does not remove or downgrade a reply already reconciled as complete", () => {
    const complete: Conversation = { ...conversation, turns: [previous, { ...pending, state: "complete" }] };
    expect(rejectOptimisticTurn(complete, pending.id, undefined)).toBe(complete);
    expect(rejectOptimisticTurn(undefined, pending.id, undefined)).toBeUndefined();
  });
});
