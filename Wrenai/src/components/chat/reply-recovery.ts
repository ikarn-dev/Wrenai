import type { ChatTurn, Conversation } from "@/shared/chat";

/** Undo only a rejected local placeholder; never erase an authoritative completed reply. */
export function rejectOptimisticTurn(
  current: Conversation | undefined,
  requestId: string,
  previous: ChatTurn | undefined,
): Conversation | undefined {
  if (!current || current.turns.some((turn) => turn.id === requestId && turn.state === "complete")) {
    return current;
  }
  const turns = current.turns.filter((turn) => turn.id !== requestId);
  if (previous) {
    turns.push(previous);
  }
  return { ...current, turns: turns.sort((left, right) => left.sequence - right.sequence) };
}
