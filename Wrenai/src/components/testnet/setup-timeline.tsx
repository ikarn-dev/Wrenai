import type { ReactElement, ReactNode } from "react";
import { SetupTimeline, type TimelineStep } from "@/components/agents/deploy-timeline";
import type { TestnetRule } from "@/shared/testnet";
import { testnetRuleText } from "@/shared/testnet-agents";
import { ordersThatFit, plannedOrders } from "@/shared/testnet-schedule";

/** The testnet setup dialog's state. Each timeline step reads its status from this. */
export type TestnetPhase =
  | { readonly step: "setup" }
  | { readonly step: "verifying"; readonly since: number }
  | { readonly step: "verify_failed" }
  | { readonly step: "review"; readonly rule: TestnetRule; readonly verifyMs: number }
  | {
      readonly step: "deploying";
      readonly rule: TestnetRule;
      readonly verifyMs: number;
      readonly since: number;
    }
  | { readonly step: "deploy_failed"; readonly rule: TestnetRule; readonly verifyMs: number }
  | {
      readonly step: "done";
      readonly rule: TestnetRule;
      readonly verifyMs: number;
      readonly deployMs: number;
      readonly agentId: string;
    };

const UTC = new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: "UTC" });

/** The parsed rules, as the review step shows them. */
export function TestnetRules({ rule }: { readonly rule: TestnetRule }): ReactElement {
  const planned = plannedOrders(rule),
    fits = ordersThatFit(rule, Date.now());
  return (
    <div className="flex flex-col gap-1.5 border-t border-line-card pt-3">
      <p className="text-small text-fg">{testnetRuleText(rule)}</p>
      <p className="text-caption text-fg-muted">
        {rule.location === "intents" ? "Public Intents" : "Wallet"} · Ends {UTC.format(rule.expiresAt)} UTC
        {rule.kind === "dca" ? ` · ${planned} orders, one every ${rule.intervalSeconds} s` : ""}
      </p>
      {fits < planned ? (
        <p role="status" className="text-caption text-warn">
          Only {fits} of {planned} orders fit before it ends.
        </p>
      ) : null}
    </div>
  );
}

function verifyStep(phase: TestnetPhase): TimelineStep {
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
      return { ...base, status: "done", detail: "Model response verified.", durationMs: phase.verifyMs };
  }
}

function reviewStep(phase: TestnetPhase): TimelineStep {
  const base = { id: "review", label: "Review", title: "Review the rules" } as const;
  switch (phase.step) {
    case "setup":
    case "verifying":
    case "verify_failed":
      return { ...base, status: "pending", detail: "Check the parsed rules before deploying." };
    case "review":
      return {
        ...base,
        status: "active",
        detail: "Check these rules, then deploy.",
        body: <TestnetRules rule={phase.rule} />,
      };
    default:
      return { ...base, status: "done", detail: "Rules confirmed." };
  }
}

function deployStep(phase: TestnetPhase, done: ReactNode): TimelineStep {
  const base = { id: "deploy", label: "Start", title: "Reserve the budget and start" } as const;
  switch (phase.step) {
    case "deploying":
      return {
        ...base,
        status: "active",
        detail: "Reserving test funds and starting the agent…",
        since: phase.since,
      };
    case "deploy_failed":
      return { ...base, status: "failed", detail: "Not started. Retry uses the same request." };
    case "done":
      return {
        ...base,
        status: "done",
        detail: "Budget reserved. The agent is running.",
        durationMs: phase.deployMs,
        body: done,
      };
    default:
      return { ...base, status: "pending", detail: "Test funds move to the agent's own balance." };
  }
}

/** Verify, review, then reserve and start: testnet creates and starts an agent in one step. */
export function TestnetSetupTimeline({
  phase,
  done,
}: {
  readonly phase: TestnetPhase;
  /** Shown under the last step once the agent runs. */
  readonly done: ReactNode;
}): ReactElement {
  return <SetupTimeline steps={[verifyStep(phase), reviewStep(phase), deployStep(phase, done)]} />;
}
