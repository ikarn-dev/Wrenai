"use client";

import { useLenis } from "lenis/react";
import { Check, LoaderCircle, Rocket, X } from "lucide-react";
import { m } from "motion/react";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { type FormEvent, type ReactElement, useEffect, useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createAgentWithBudget, parseAgentStrategy } from "@/server/agents/actions";
import type { AgentBudgetInput } from "@/shared/agent-budget";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import { type CreateAgentRequest, createRequestKey } from "@/shared/agent-create-request";
import { agentTemplate } from "@/shared/agent-templates";
import {
  type AgentPolicy,
  type AgentSummary,
  DEFAULT_POLICY,
  policySchema,
  type StrategyDraft,
} from "@/shared/agents";
import { AgentAvatar } from "./avatar";
import { CreateAgentFields } from "./create-agent-fields";
import { type DeployPhase, DeployTimeline } from "./deploy-timeline";
import { StrategySummary } from "./strategy-summary";

const BUTTON_ICON = { size: 18, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;
const EYEBROW = "font-mono text-eyebrow uppercase text-fg-muted";

function initialPolicy(pack: AgentSummary["pack"]): AgentPolicy {
  return {
    ...DEFAULT_POLICY,
    allowRiskReducingExits: true,
    ...(pack === "perps" ? { maxProviderFeeBps: 10 } : {}),
  };
}

/**
 * Agent creation as a popup on the Agents page. The page's `?create=` or `?setup=` link opens it; closing or
 * finishing clears the link, so the user stays on Agents and the list behind updates.
 */
export function CreateAgentDialog({
  request,
}: {
  readonly request: CreateAgentRequest | null;
}): ReactElement {
  const router = useRouter();
  const lenis = useLenis();
  const entry = request ? { key: createRequestKey(request), request } : null;
  const [seen, setSeen] = useState<string | null>(entry?.key ?? null);
  const [opened, setOpened] = useState(entry);
  // A new link opens the dialog. The same link stays closed after the user closes it, until the URL changes.
  if ((entry?.key ?? null) !== seen) {
    setSeen(entry?.key ?? null);
    if (entry) {
      setOpened(entry);
    }
  }
  const open = opened !== null;

  // Lenis would keep scrolling the page behind the dialog (Docs/tech-stack.md → Lenis).
  useEffect(() => {
    if (!open || lenis === undefined) {
      return;
    }
    lenis.stop();
    return () => lenis.start();
  }, [open, lenis]);

  function clearLink(): void {
    if (seen !== null) {
      router.replace("/agents", { scroll: false });
    }
  }

  function close(): void {
    setOpened(null);
    clearLink();
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : close())}>
      {opened ? (
        <CreateAgentFlow key={opened.key} request={opened.request} onClose={close} onCreated={clearLink} />
      ) : null}
    </Dialog.Root>
  );
}

interface CreateAgentFlowProps {
  readonly request: CreateAgentRequest;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}

function CreateAgentFlow({ request, onClose, onCreated }: CreateAgentFlowProps): ReactElement {
  const formId = useId();
  const [pack, setPack] = useState(request.pack);
  // A new agent opens on its type's preset strategy; a saved setup or a brief from chat keeps its own text.
  const [text, setText] = useState(request.brief || agentTemplate(request.pack));
  const [budget, setBudget] = useState<AgentBudgetInput | null>(request.setup?.budget ?? null);
  const [policy, setPolicy] = useState<AgentPolicy>(() => initialPolicy(request.pack));
  const [phase, setPhase] = useState<DeployPhase>({ step: "setup" });
  const [formError, setFormError] = useState<string | null>(null);
  // Retries reuse these ids, so a lost reply recovers the same review or agent instead of creating another.
  const [requestId, setRequestId] = useState<string | null>(null);
  const [saveId, setSaveId] = useState<string | null>(null);
  const busy = phase.step === "verifying" || phase.step === "saving";
  const item = AGENT_CATALOG[pack];

  function invalidate(): void {
    setRequestId(null);
    setSaveId(null);
    setFormError(null);
  }

  async function verify(): Promise<void> {
    const id = requestId ?? crypto.randomUUID();
    setRequestId(id);
    setPhase({ step: "verifying" });
    const started = performance.now();
    try {
      const result = await parseAgentStrategy({
        requestId: id,
        pack,
        strategyText: text,
        ...(budget ? { budget } : {}),
      });
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

  async function save(draft: StrategyDraft, verifyMs: number): Promise<void> {
    const limits = policySchema.safeParse(policy);
    if (!limits.success) {
      const message = limits.error.issues[0]?.message ?? "Check your risk limits.";
      setPhase({ step: "save_failed", draft, verifyMs, message });
      return;
    }
    const id = saveId ?? crypto.randomUUID();
    setSaveId(id);
    setPhase({ step: "saving", draft, verifyMs });
    const started = performance.now();
    try {
      const result = await createAgentWithBudget({
        requestId: id,
        draftId: draft.id,
        policy: limits.data,
        agentId: null,
        expectedRevision: null,
        budget,
        ...(request.setup ? { setupId: request.setup.id, setupHash: request.setup.hash } : {}),
      });
      if (!result.ok) {
        setPhase({ step: "save_failed", draft, verifyMs, message: result.message });
        return;
      }
      const saveMs = performance.now() - started;
      setPhase({ step: "done", draft, verifyMs, saveMs, agentId: result.value.agentId });
      onCreated();
    } catch {
      const message = "The save could not be confirmed. Retry to recover it without creating a duplicate.";
      setPhase({ step: "save_failed", draft, verifyMs, message });
    }
  }

  function deploy(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const limits = policySchema.safeParse(policy);
    if (!limits.success) {
      setFormError(limits.error.issues[0]?.message ?? "Check your risk limits.");
      return;
    }
    setFormError(null);
    void verify();
  }

  const editSetup = (
    <Button variant="soft" onClick={() => setPhase({ step: "setup" })}>
      Edit setup
    </Button>
  );

  function actions(): ReactElement {
    switch (phase.step) {
      case "setup":
        return (
          <>
            <Dialog.Close asChild>
              <Button variant="soft">Cancel</Button>
            </Dialog.Close>
            <Button type="submit" form={formId} variant="primary">
              <Rocket {...BUTTON_ICON} />
              Deploy agent
            </Button>
          </>
        );
      case "verifying":
      case "saving":
        return (
          <Button variant="primary" aria-busy="true">
            <LoaderCircle {...BUTTON_ICON} className="motion-safe:animate-spin" />
            {phase.step === "verifying" ? "Verifying…" : "Saving…"}
          </Button>
        );
      case "review": {
        const { draft, verifyMs } = phase;
        return (
          <>
            {editSetup}
            <Button variant="primary" onClick={() => void save(draft, verifyMs)}>
              Confirm and deploy
            </Button>
          </>
        );
      }
      case "verify_failed":
        return (
          <>
            {editSetup}
            <Button variant="primary" onClick={() => void verify()}>
              Retry
            </Button>
          </>
        );
      case "save_failed": {
        const { draft, verifyMs } = phase;
        return (
          <>
            {editSetup}
            <Button variant="primary" onClick={() => void save(draft, verifyMs)}>
              Retry save
            </Button>
          </>
        );
      }
      case "done":
        return (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        );
      default: {
        const unhandled: never = phase;
        throw new Error(`Unhandled deploy phase: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  function note(): string {
    switch (phase.step) {
      case "setup":
        return "Saved paused. Nothing trades until you fund and start it.";
      case "verifying":
      case "saving":
        return "Keep this open until it finishes.";
      case "review":
        return budget
          ? "Confirming reserves the budget and saves the agent paused."
          : "Confirming saves the agent paused.";
      case "verify_failed":
        return "Edit the setup, or retry.";
      case "save_failed":
        return "Retry uses the same request, so no duplicate is created.";
      case "done":
        return "Your agent is in the list below, paused.";
      default: {
        const unhandled: never = phase;
        throw new Error(`Unhandled deploy phase: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  const review =
    phase.step === "review" ? (
      <div className="flex flex-col gap-3 rounded-md bg-sunken p-4">
        <div className="flex items-center justify-between gap-3">
          <span className={EYEBROW}>Parsed rules</span>
          <Badge tone="accent">
            <Check aria-hidden="true" size={12} />
            Model verified
          </Badge>
        </div>
        <StrategySummary strategy={phase.draft.strategy} />
      </div>
    ) : null;

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-bg/80" />
      <Dialog.Content
        // Outside clicks never close it, so a stray click can't discard the setup. Escape and Close do, except
        // while a step runs, so its result has somewhere to show.
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => (busy ? event.preventDefault() : undefined)}
        className="fixed inset-x-gutter top-1/2 z-50 mx-auto flex max-h-[calc(100dvh-2rem)] max-w-xl -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-surface-2 shadow-float"
      >
        <header className="flex items-center gap-3 px-card pt-card pr-16">
          <AgentAvatar size={28} running={busy} />
          <div className="flex min-w-0 flex-col gap-1">
            <Dialog.Title className="truncate font-rounded text-h2 font-bold text-fg-strong">
              New {item.name}
            </Dialog.Title>
            <Dialog.Description className="text-caption text-fg-muted">{item.description}</Dialog.Description>
          </div>
        </header>
        <div data-lenis-prevent className="min-h-0 flex-1 overflow-y-auto px-card pt-5 pb-card">
          {phase.step === "setup" ? (
            <form id={formId} onSubmit={deploy}>
              <CreateAgentFields
                pack={pack}
                packLocked={request.setup !== null}
                onPackChange={(next) => {
                  // Switching type swaps in its preset, unless the user has written their own strategy.
                  if (text.trim() === "" || text === agentTemplate(pack)) {
                    setText(agentTemplate(next));
                  }
                  setPack(next);
                  invalidate();
                }}
                text={text}
                onTextChange={(next) => {
                  setText(next);
                  invalidate();
                }}
                budget={budget}
                onBudgetChange={(next) => {
                  setBudget(next);
                  invalidate();
                }}
                setupId={request.setup?.id ?? null}
                policy={policy}
                onPolicyChange={(next) => {
                  setPolicy(next);
                  setSaveId(null);
                }}
              />
            </form>
          ) : (
            <m.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, ease: "easeOut" }}
              className="flex flex-col gap-6"
            >
              <div className="flex flex-col gap-1.5 rounded-md bg-sunken p-4">
                <span className={EYEBROW}>Strategy</span>
                <p className="line-clamp-3 whitespace-pre-line text-small text-fg">{text}</p>
              </div>
              <DeployTimeline phase={phase} budgeted={budget !== null} review={review} />
            </m.div>
          )}
        </div>
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line-card px-card py-4">
          {phase.step === "setup" && formError ? (
            <p role="alert" className="text-small text-loss">
              {formError}
            </p>
          ) : (
            <p className="text-caption text-fg-subtle">{note()}</p>
          )}
          <div className="ml-auto flex items-center gap-3">{actions()}</div>
        </footer>
        {busy ? null : (
          <Dialog.Close
            aria-label="Close"
            className="absolute top-4 right-4 inline-flex size-9 cursor-pointer items-center justify-center rounded-full text-fg-subtle transition-colors duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong pointer-coarse:size-11"
          >
            <X aria-hidden="true" size={16} strokeWidth={1.75} absoluteStrokeWidth />
          </Dialog.Close>
        )}
      </Dialog.Content>
    </Dialog.Portal>
  );
}
