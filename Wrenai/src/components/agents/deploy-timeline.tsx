import { Circle, CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { m } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import type { StrategyDraft } from "@/shared/agents";
import { useNow } from "./live-view";

/** The create dialog's state. Each timeline step reads its status from this, so no step can show progress the
 * app hasn't observed. */
export type DeployPhase =
  | { readonly step: "setup" }
  | { readonly step: "verifying"; readonly since: number }
  | { readonly step: "verify_failed"; readonly message: string }
  | { readonly step: "review"; readonly draft: StrategyDraft; readonly verifyMs: number }
  | {
      readonly step: "saving";
      readonly draft: StrategyDraft;
      readonly verifyMs: number;
      readonly since: number;
    }
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
      readonly revision: number;
    };

export type StepStatus = "pending" | "active" | "done" | "failed";

/** One step of a setup timeline. Errors are not shown here: the caller raises them as a toast. */
export interface TimelineStep {
  readonly id: string;
  /** One word for the stepper; `title` heads the step's panel. */
  readonly label: string;
  readonly title: string;
  readonly status: StepStatus;
  readonly detail: ReactNode;
  readonly durationMs?: number;
  /** When an active step started, for its live timer. */
  readonly since?: number;
  readonly body?: ReactNode;
}

const ICON = { size: 14, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;

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
  const base = { id: "verify", label: "Verify", title: "Verify strategy" } as const;
  switch (phase.step) {
    case "setup":
      return { ...base, status: "pending", detail: "Verified AI turns your text into rules." };
    case "verifying":
      return {
        ...base,
        status: "active",
        detail: "Checking the model's attestation, then reading your rules. Usually 10–40 s.",
        since: phase.since,
      };
    case "verify_failed":
      return { ...base, status: "failed", detail: "Not verified. Edit the setup or retry." };
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
  const base = { id: "review", label: "Review", title: "Review the rules" } as const;
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
  const base = {
    id: "save",
    label: budgeted ? "Reserve" : "Save",
    title: budgeted ? "Reserve the budget" : "Save the agent",
  } as const;
  switch (phase.step) {
    case "saving":
      return { ...base, status: "active", detail: "Saving the agent…", since: phase.since };
    case "save_failed":
      return { ...base, status: "failed", detail: "Not saved. Retry uses the same request." };
    case "done":
      return {
        ...base,
        status: "done",
        detail: budgeted
          ? "Budget set aside in your wallet. The agent waits for its funds."
          : "Agent saved, not running yet.",
        durationMs: phase.saveMs,
      };
    default:
      return { ...base, status: "pending", detail: "Nothing trades until you start it." };
  }
}

/** The steps after Deploy, top to bottom, each with its observed status, duration and any error. */
export function DeployTimeline({
  phase,
  budgeted,
  review,
  launch,
}: {
  readonly phase: DeployPhase;
  readonly budgeted: boolean;
  readonly review: ReactNode;
  /** Funding and Start, shown once the agent is saved. */
  readonly launch: ReactNode;
}): ReactElement {
  const steps: readonly TimelineStep[] = [
    verifyStep(phase),
    reviewStep(phase, review),
    saveStep(phase, budgeted),
    phase.step === "done"
      ? {
          id: "start",
          label: "Start",
          title: "Add funds and deploy",
          status: "active",
          detail: "One wallet approval moves the budget to the agent. Deploy starts it.",
          body: launch,
        }
      : {
          id: "start",
          label: "Start",
          title: "Add funds and deploy",
          status: "pending",
          detail: "One wallet approval moves the budget in. Then Deploy starts the agent.",
        },
  ];
  return <SetupTimeline steps={steps} />;
}

function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The step the panel shows: the one running or failed, otherwise the last one finished. */
function focusStep(steps: readonly TimelineStep[]): TimelineStep | undefined {
  return (
    steps.find((step) => step.status === "active" || step.status === "failed") ??
    steps.findLast((step) => step.status === "done")
  );
}

/**
 * Setup progress as a compact stepper with one panel for the step in focus: numbered dots joined by a line that
 * fills as steps finish, then the current step's state, live timer and content. Errors come as toasts, so a failed
 * step only says what to do next. Shared by both networks.
 */
export function SetupTimeline({ steps }: { readonly steps: readonly TimelineStep[] }): ReactElement {
  const focus = focusStep(steps);
  const now = useNow(focus?.status === "active" && focus.since !== undefined);
  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="sr-only">
        {focus ? `${focus.title}: ${STATUS_WORD[focus.status]}` : ""}
      </p>
      <ol aria-label="Deploy progress" className="flex items-center">
        {steps.map((step, index) => (
          <li key={step.id} className={`flex min-w-0 items-center ${index === 0 ? "" : "flex-1"}`}>
            {index === 0 ? null : (
              <span
                aria-hidden="true"
                className="relative mx-2 h-px min-w-4 flex-1 overflow-hidden bg-line-card"
              >
                <span
                  className={`absolute inset-0 origin-left bg-accent-line transition-transform duration-500 ease-ios ${
                    steps[index - 1]?.status === "done" ? "scale-x-100" : "scale-x-0"
                  }`}
                />
              </span>
            )}
            <span
              aria-current={step === focus ? "step" : undefined}
              className={`inline-flex shrink-0 items-center gap-1.5 text-caption ${
                step.status === "failed"
                  ? "text-loss"
                  : step.status === "pending"
                    ? "text-fg-subtle"
                    : "text-fg-strong"
              }`}
            >
              <StepIcon status={step.status} />
              <span className={step === focus ? "font-medium" : ""}>{step.label}</span>
              <span className="sr-only">: {STATUS_WORD[step.status]}</span>
            </span>
          </li>
        ))}
      </ol>
      {focus ? (
        <m.section
          key={`${focus.id}:${focus.status}`}
          aria-label={focus.title}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="flex flex-col gap-3 rounded-md bg-sunken p-4"
        >
          <div className="flex items-baseline justify-between gap-3">
            <p
              className={`text-small font-medium ${focus.status === "failed" ? "text-loss" : "text-fg-strong"}`}
            >
              {focus.title}
            </p>
            {focus.status === "active" && focus.since !== undefined ? (
              <span className="font-mono text-caption tabular-nums text-fg-subtle" suppressHydrationWarning>
                {elapsed(now - focus.since)}
              </span>
            ) : focus.durationMs === undefined ? null : (
              <span className="font-mono text-caption tabular-nums text-fg-subtle">
                {seconds(focus.durationMs)}
              </span>
            )}
          </div>
          <p className="text-caption text-fg-muted">{focus.detail}</p>
          {focus.status === "active" && focus.since !== undefined ? (
            <span
              aria-hidden="true"
              className="relative block h-0.5 overflow-hidden rounded-full bg-surface-2"
            >
              <span className="live-travel absolute inset-y-0 left-0 w-1/3 rounded-full bg-accent" />
            </span>
          ) : null}
          {focus.body ?? null}
        </m.section>
      ) : null}
    </div>
  );
}
