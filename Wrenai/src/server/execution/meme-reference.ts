import "server-only";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { agentRuntimes } from "@/server/db/agent-schema";
import type { AppDatabase } from "@/server/db/client";
import { decideMemePosition } from "@/server/engine/meme-decision";
import { memeSlot } from "@/server/engine/meme-state";
import type { TradeQuote } from "@/shared/trade-preview";
import type { currentAgentStrategy } from "./asset-review";
import { ExecutionError } from "./contracts";
import type { swapSignalSchema } from "./intents-order";
import { assertMemePair, readMemeDecision } from "./meme-binding";
import { executionEvent, executionHash, ownedExecution } from "./records";

export async function memeSubmissionCheck(
  db: AppDatabase,
  current: Awaited<ReturnType<typeof currentAgentStrategy>>,
  signal: z.infer<typeof swapSignalSchema> | undefined,
  quote: TradeQuote,
  actionId?: string,
): Promise<(tx: AppDatabase) => Promise<void>> {
  const instruction = current.strategy;
  if (instruction.kind !== "meme_hunter") {
    throw new ExecutionError("not_ready", "A reviewed hunter instruction is required.");
  }
  const persisted = await readMemeDecision(
    db,
    current.agent.userId,
    current.agent.id,
    current.agent.version,
    instruction,
  );
  const { state, position, stored } = persisted;
  if (
    !signal ||
    persisted.revision !== current.agent.revision ||
    signal.instructionSlot !== memeSlot(position) ||
    (state.pendingActionId !== null && state.pendingActionId !== actionId)
  ) {
    throw new ExecutionError("conflict", "The order does not own this hunter's persisted slot.");
  }
  assertMemePair(instruction, persisted, signal);
  let checked: Awaited<ReturnType<typeof decideMemePosition>>;
  try {
    checked = await decideMemePosition(db, current, instruction, state, position, quote, actionId);
  } catch (error) {
    if (error instanceof ExecutionError) {
      throw error;
    }
    throw new ExecutionError(
      "not_ready",
      "Current holder, contract, pool or route evidence could not be verified before signing.",
    );
  }
  const fresh = checked.decision.signal,
    entry = signal.purpose === "instruction_entry";
  if (
    !fresh ||
    signal.instructionSlot !== `${position.asset.assetId}:${fresh.instructionSlot}` ||
    fresh.inputAssetId !== signal.inputAssetId ||
    fresh.outputAssetId !== signal.outputAssetId ||
    fresh.inputUnits !== signal.inputUnits ||
    fresh.purpose !== signal.purpose
  ) {
    throw new ExecutionError(
      "not_ready",
      "The candidate or owned-position exit no longer satisfies the reviewed instruction.",
    );
  }
  return async (tx) => {
    const [runtime] = await tx
      .select()
      .from(agentRuntimes)
      .where(eq(agentRuntimes.agentId, current.agent.id))
      .limit(1);
    const now = Date.now(),
      evidence = checked.position.evidence;
    if (
      runtime?.strategyStateJson !== stored ||
      runtime.state !== "active" ||
      runtime.strategyVersion !== current.agent.version ||
      runtime.agentRevision !== current.agent.revision ||
      quote.expiresAt <= now ||
      checked.quoteExpiresAt <= now ||
      checked.priceAt > now + 1000 ||
      now - checked.priceAt >= 5000 ||
      (entry &&
        (now >= Date.parse(instruction.expiresAt) ||
          evidence.observedAt > now + 1000 ||
          now - evidence.observedAt >= 15000 ||
          evidence.riskCheckedAt > now + 1000 ||
          now - evidence.riskCheckedAt >= 60000 ||
          evidence.createdAt > now ||
          now - evidence.createdAt > instruction.maximumAgeSeconds * 1000))
    ) {
      throw new ExecutionError(
        "not_ready",
        "The hunter state, risk evidence or executable price changed before signing.",
      );
    }
    if (actionId) {
      const action = await ownedExecution(tx, current.agent.userId, actionId);
      await executionEvent(tx, action, entry ? "meme_entry_verified" : "meme_exit_verified", now, {
        strategyHash: executionHash(instruction),
        policyHash: executionHash(JSON.parse(current.agent.policyJson)),
        evidence,
        risk: checked.riskEvidence,
        positionUnits: position.spot.quantityUnits,
        exitTriggered: checked.position.spot.exitTriggered,
        roundTripMinimumUnits: checked.roundTripMinimumUnits,
        quoteHash: quote.quoteHash,
        priceAt: checked.priceAt,
      });
      if (
        Date.now() - checked.priceAt >= 5000 ||
        Date.now() >= Math.min(quote.expiresAt, checked.quoteExpiresAt) ||
        (entry && (Date.now() - evidence.observedAt >= 15000 || Date.now() - evidence.riskCheckedAt >= 60000))
      ) {
        throw new ExecutionError(
          "not_ready",
          "The hunter evidence expired before the signature could be committed.",
        );
      }
    }
  };
}
