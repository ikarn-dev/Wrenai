"use client";

import { useState } from "react";
import type { AgentBudgetInput } from "@/shared/agent-budget";
import { type AgentSummary, type StrategyDraft, strategyTextSchema } from "@/shared/agents";
import type { RefineNote } from "./create-agent-fields";
import type { DeployPhase } from "./deploy-timeline";
import { refineStrategyText, reviewStrategyText } from "./review-api";

interface ReviewInput {
  readonly pack: AgentSummary["pack"];
  readonly text: string;
  readonly budget: AgentBudgetInput | null;
  readonly setPhase: (phase: DeployPhase) => void;
  readonly setText: (text: string) => void;
}

/**
 * Strategy review for the create dialog: Refine and check, and the verified parse Deploy runs. Retries reuse the
 * request ID, so a lost reply recovers the same review; a passed check is reused by Deploy without a second parse.
 */
export function useStrategyReview({ pack, text, budget, setPhase, setText }: ReviewInput): {
  readonly refining: boolean;
  readonly refineNote: RefineNote | null;
  readonly refine: () => Promise<void>;
  readonly verify: () => Promise<void>;
  readonly checkedDraft: () => { readonly draft: StrategyDraft; readonly verifyMs: number } | null;
  readonly reset: () => void;
} {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [refining, setRefining] = useState(false);
  const [refineNote, setRefineNote] = useState<RefineNote | null>(null);
  const [checked, setChecked] = useState<{
    readonly text: string;
    readonly draft: StrategyDraft;
    readonly verifyMs: number;
  } | null>(null);
  const input = (strategyText: string, id: string): object => ({
    requestId: id,
    pack,
    strategyText,
    ...(budget ? { budget } : {}),
  });

  function reset(): void {
    setRequestId(null);
    setChecked(null);
    setRefineNote(null);
  }

  async function refine(): Promise<void> {
    const instructions = strategyTextSchema.safeParse(text);
    if (!instructions.success) {
      setRefineNote({
        tone: "warn",
        text: instructions.error.issues[0]?.message ?? "Check your instructions.",
      });
      return;
    }
    const id = crypto.randomUUID();
    const started = performance.now();
    setRefining(true);
    setRefineNote(null);
    try {
      const result = await refineStrategyText(input(text, id));
      if (!result.ok) {
        setRefineNote({ tone: "warn", text: result.message });
        return;
      }
      const { text: refined, draft, problem } = result.value;
      setText(refined);
      if (draft) {
        setRequestId(id);
        setChecked({ text: refined, draft, verifyMs: performance.now() - started });
        setRefineNote({ tone: "ok", text: "Rewritten and checked. Ready to deploy." });
      } else {
        setRequestId(null);
        setChecked(null);
        setRefineNote({ tone: "warn", text: problem ?? "Check the instructions, then refine again." });
      }
    } catch {
      setRefineNote({ tone: "warn", text: "Couldn’t refine right now. Try again." });
    } finally {
      setRefining(false);
    }
  }

  async function verify(): Promise<void> {
    const id = requestId ?? crypto.randomUUID();
    setRequestId(id);
    setPhase({ step: "verifying" });
    const started = performance.now();
    try {
      const result = await reviewStrategyText(input(text, id));
      if (result.ok) {
        setPhase({ step: "review", draft: result.value, verifyMs: performance.now() - started });
        return;
      }
      if (result.code !== "in_progress" && result.code !== "unavailable") {
        setRequestId(null);
      }
      setPhase({ step: "verify_failed", message: result.message });
    } catch {
      setPhase({
        step: "verify_failed",
        message: "The request could not finish. Retry to recover the same review.",
      });
    }
  }

  return {
    refining,
    refineNote,
    refine,
    verify,
    checkedDraft: () => (checked && checked.text === text ? checked : null),
    reset,
  };
}
