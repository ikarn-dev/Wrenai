"use client";
import { useState } from "react";
import { notify } from "@/components/ui/toast";
import type { AgentBudgetInput } from "@/shared/agent-budget";
import { type AgentSummary, strategyTextSchema } from "@/shared/agents";
import { parseBudgetHint } from "@/shared/budget-hint";
import type { RefineNote } from "./create-agent-fields";
import type { DeployPhase } from "./deploy-timeline";
import { refineStrategyText, reviewStrategyText } from "./review-api";
import { useEarlyCheck } from "./use-early-check";

interface ReviewInput {
  readonly pack: AgentSummary["pack"];
  readonly text: string;
  readonly budget: AgentBudgetInput | null;
  readonly setPhase: (phase: DeployPhase) => void;
  readonly setText: (text: string) => void;
  /** True while the setup form is open: the only time a check may start early. */
  readonly editing: boolean;
}

type ReviewReply = Awaited<ReturnType<typeof reviewStrategyText>>;
// Failures that a fresh request can fix; any other early failure is the strategy's own answer and is shown as is.
const RETRYABLE: ReadonlySet<string> = new Set(["unavailable", "in_progress", "rate_limited"]);
/**
 * Strategy review for the create dialog. Refine only rewrites the text. The verified parse starts on its own once the
 * text, type and budget stop changing, so Continue usually finds it done; Continue reuses it only for those exact
 * inputs. Retries reuse the request ID, so a lost reply recovers the same review.
 */
export function useStrategyReview({ pack, text, budget, setPhase, setText, editing }: ReviewInput): {
  readonly refining: boolean;
  readonly refineNote: RefineNote | null;
  readonly refine: () => Promise<void>;
  readonly verify: () => Promise<void>;
  readonly reset: () => void;
} {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [refining, setRefining] = useState(false);
  const [refineNote, setRefineNote] = useState<RefineNote | null>(null);
  const input = (strategyText: string, id: string): object => ({
    requestId: id,
    pack,
    strategyText,
    ...(budget ? { budget } : {}),
  });
  const inputsKey = JSON.stringify([pack, text, budget]);
  const ready =
    editing &&
    !refining &&
    strategyTextSchema.safeParse(text).success &&
    !/\{\{[^}]+\}\}/.test(text) &&
    !(pack === "spot_trader" && (parseBudgetHint(text, true)?.count ?? 1) > 1);
  const early = useEarlyCheck<{ readonly id: string; readonly reply: ReviewReply }>(
    ready ? inputsKey : null,
    async (signal) => {
      const id = crypto.randomUUID();
      return { id, reply: await reviewStrategyText(input(text, id), signal) };
    },
  );
  function reset(): void {
    setRequestId(null);
    setRefineNote(null);
  }
  /** Uses the early check for these inputs if it can; false when a fresh request is needed. */
  async function takeEarly(): Promise<boolean> {
    const check = early.take(inputsKey);
    if (!check) {
      return false;
    }
    setPhase({ step: "verifying", since: check.startedAt });
    const settled = await check.result;
    if (!settled.ok) {
      return false;
    }
    const { id, reply } = settled.value;
    if (reply.ok) {
      setRequestId(id);
      setPhase({ step: "review", draft: reply.value, verifyMs: Date.now() - check.startedAt });
      return true;
    }
    if (RETRYABLE.has(reply.code)) {
      return false;
    }
    setPhase({ step: "verify_failed", message: reply.message });
    notify("error", reply.message);
    return true;
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
    setRefining(true);
    setRefineNote(null);
    try {
      const result = await refineStrategyText(input(text, crypto.randomUUID()));
      if (!result.ok) {
        setRefineNote({ tone: "warn", text: result.message });
        return;
      }
      setText(result.value.text);
      setRequestId(null);
      setRefineNote(
        result.value.note
          ? { tone: "warn", text: result.value.note }
          : { tone: "ok", text: "Rewritten. Review it, then continue." },
      );
    } catch {
      setRefineNote({ tone: "warn", text: "Couldn’t refine right now. Try again." });
    } finally {
      setRefining(false);
    }
  }
  async function verify(): Promise<void> {
    if (await takeEarly()) {
      return;
    }
    const id = requestId ?? crypto.randomUUID();
    setRequestId(id);
    setPhase({ step: "verifying", since: Date.now() });
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
      notify("error", result.message);
    } catch {
      const message = "The request could not finish. Retry to recover the same review.";
      setPhase({ step: "verify_failed", message });
      notify("error", message);
    }
  }
  return { refining, refineNote, refine, verify, reset };
}
