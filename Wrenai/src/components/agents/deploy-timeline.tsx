import { Circle, CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { m } from "motion/react";
import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import type { StrategyDraft } from "@/shared/agents";

/** The create dialog's state. Each timeline step reads its status from this, so no step can show progress the
 * app hasn't observed. */
export type DeployPhase =
  | { readonly step: "setup" }
  | { readonly step: "verifying" }
  | { readonly step: "verify_failed"; readonly message: string }
  | { readonly step: "review"; readonly draft: StrategyDraft; readonly verifyMs: number }
  | { readonly step: "saving"; readonly draft: StrategyDraft; readonly verifyMs: number }
  | {
      readonly step: "save_failed";
      readonly draft: StrategyDraft;
      readonly verifyMs: number;
      readonly message: string;
    }
  | {
      readonly step: "done";
      readonly draft: StrategyDraft;
      readonly verifyMs: number;
      readonly saveMs: number;
      readonly agentId: string;
    };

type StepStatus = "pending" | "active" | "done" | "failed";

interface TimelineStep {
  readonly id: string;
  readonly title: string;
  readonly status: StepStatus;
  readonly detail: ReactNode;
  readonly durationMs?: number;
  readonly error?: string;
  readonly body?: ReactNode;
}

const ICON = { size: 20, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;

const STATUS_WORD: Readonly<Record<StepStatus, string>> = {
  pending: "Not started",
  active: "In progress",
  done: "Done",
  failed: "Failed",
};

function StepIcon({ status }: { readonly status: StepStatus }): ReactElement {
  switch (status) {
    case "pending":
      return <Circle {...ICON} className="text-fg-subtle" />;
    case "active":
      return <LoaderCircle {...ICON} className="text-accent-text motion-safe:animate-spin" />;
    case "done":
      return <CircleCheck {...ICON} className="text-accent-text" />;
    case "failed":
      return <CircleAlert {...ICON} className="text-loss" />;
    default: {
      const unhandled: never = status;
      throw new Error(`Unhandled step status: ${String(unhandled)}`);
    }
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function verifyStep(phase: DeployPhase): TimelineStep {
  const base = { id: "verify", title: "Verify strategy" } as const;
  switch (phase.step) {
    case "setup":
      return { ...base, status: "pending", detail: "Verified AI turns your text into rules." };
    case "verifying":
      return { ...base, status: "active", detail: "Reading your strategy with verified AI…" };
    case "verify_failed":
      return { ...base, status: "failed", detail: "The strategy was not verified.", error: phase.message };
    default:
      return {
        ...base,
        status: "done",
        detail: "Model response verified.",
        durationMs: phase.verifyMs,
      };
  }
}

function reviewStep(phase: DeployPhase, review: ReactNode): TimelineStep {
  const base = { id: "review", title: "Review the rules" } as const;
  switch (phase.step) {
    case "setup":
    case "verifying":
    case "verify_failed":
      return { ...base, status: "pending", detail: "Check the parsed rules before saving." };
    case "review":
      return { ...base, status: "active", detail: "Check these rules, then confirm.", body: review };
    default:
      return { ...base, status: "done", detail: "Rules confirmed." };
  }
}

function saveStep(phase: DeployPhase, budgeted: boolean): TimelineStep {
  const base = { id: "save", title: budgeted ? "Reserve budget and save" : "Save agent" } as const;
  switch (phase.step) {
    case "saving":
      return { ...base, status: "active", detail: "Saving the agent…" };
    case "save_failed":
      return { ...base, status: "failed", detail: "The agent was not saved.", error: phase.message };
    case "done":
      return {
        ...base,
        status: "done",
        detail: (
          <>
            {budgeted ? "Budget reserved. " : ""}Saved paused.{" "}
            <Link
              href={`/agents/${phase.agentId}`}
              className="text-accent-text underline-offset-4 hover:underline"
            >
              Open agent
            </Link>
          </>
        ),
        durationMs: phase.saveMs,
      };
    default:
      return { ...base, status: "pending", detail: "Saved paused, so nothing trades yet." };
  }
}

/** The steps after Deploy, top to bottom, each with its observed status, duration and any error. */
export function DeployTimeline({
  phase,
  budgeted,
  review,
}: {
  readonly phase: DeployPhase;
  readonly budgeted: boolean;
  readonly review: ReactNode;
}): ReactElement {
  const steps: readonly TimelineStep[] = [
    verifyStep(phase),
    reviewStep(phase, review),
    saveStep(phase, budgeted),
    {
      id: "start",
      title: "Fund and start",
      status: "pending",
      detail: "Funding and Start are on the agent page.",
    },
  ];
  const current = steps.find((step) => step.status === "active" || step.status === "failed");
  return (
    <>
      <p role="status" className="sr-only">
        {current ? `${current.title}: ${STATUS_WORD[current.status]}` : ""}
      </p>
      <ol aria-label="Deploy progress" className="flex flex-col">
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          return (
            <li key={step.id} className="flex gap-3">
              <div className="flex w-5 shrink-0 flex-col items-center">
                <StepIcon status={step.status} />
                {last ? null : (
                  <span
                    aria-hidden="true"
                    className={`my-1.5 w-px flex-1 transition-colors duration-300 ease-ios ${step.status === "done" ? "bg-accent-line" : "bg-line-card"}`}
                  />
                )}
              </div>
              <div className={`flex min-w-0 flex-1 flex-col gap-1 ${last ? "" : "pb-6"}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <h3
                    className={`text-body font-medium ${step.status === "pending" ? "text-fg-muted" : "text-fg-strong"}`}
                  >
                    {step.title}
                    <span className="sr-only">: {STATUS_WORD[step.status]}</span>
                  </h3>
                  {step.durationMs === undefined ? null : (
                    <span className="font-mono text-caption tabular-nums text-fg-subtle">
                      {seconds(step.durationMs)}
                    </span>
                  )}
                </div>
                <p className="text-small text-fg-muted">{step.detail}</p>
                {step.error ? (
                  <m.p
                    role="alert"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className="mt-2 rounded-sm bg-loss-soft p-3 text-small text-loss"
                  >
                    {step.error}
                  </m.p>
                ) : null}
                {step.body ? (
                  <m.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.24, ease: "easeOut" }}
                    className="mt-3"
                  >
                    {step.body}
                  </m.div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}
