"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useLenis } from "lenis/react";
import { ArrowRight, Check, LoaderCircle } from "lucide-react";
import { m } from "motion/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Dialog } from "radix-ui";
import { type FormEvent, type ReactElement, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import type { AgentBudgetInput } from "@/shared/agent-budget";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import {
  type CreateAgentRequest,
  createRequestKey,
  createRequestPack,
  needsServerRequest,
} from "@/shared/agent-create-request";
import { usesPublicRoute } from "@/shared/agent-instructions";
import {
  type AgentPolicy,
  type AgentSummary,
  DEFAULT_POLICY,
  policySchema,
  type StrategyDraft,
  strategyTextSchema,
} from "@/shared/agents";
import { parseBudgetHint } from "@/shared/budget-hint";
import { agentListKey } from "./agents-section";
import { CreateAgentFields } from "./create-agent-fields";
import { DeployLaunch, type LaunchContext } from "./deploy-launch";
import { type DeployPhase, DeployTimeline } from "./deploy-timeline";
import { createAgentRequest } from "./review-api";
import { AgentSetupDialogFrame } from "./setup-dialog-frame";
import { StrategySummary } from "./strategy-summary";
import { useInstructionBudget } from "./use-instruction-budget";
import { useStrategyReview } from "./use-strategy-review";

const BUTTON_ICON = { size: 16, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;

function initialPolicy(pack: AgentSummary["pack"]): AgentPolicy {
  return {
    ...DEFAULT_POLICY,
    allowRiskReducingExits: true,
    ...(pack === "perps" ? { maxProviderFeeBps: 10 } : {}),
  };
}

type Pack = AgentSummary["pack"];
interface SetupFields {
  readonly text: string;
  readonly budget: AgentBudgetInput | null;
  /** The user chose the budget themselves; until then it follows the instructions. */
  readonly budgetTouched: boolean;
  readonly policy: AgentPolicy;
}

function blankSetup(pack: Pack): SetupFields {
  return { text: "", budget: null, budgetTouched: false, policy: initialPolicy(pack) };
}

/**
 * Agent creation as a popup on the Agents page. The page's `?create=` link opens it; closing or
 * finishing clears the link, so the user stays on Agents and the list behind updates.
 */
export function CreateAgentDialog({
  request,
  launch,
  onClose,
}: {
  readonly request: CreateAgentRequest | null;
  readonly launch: LaunchContext;
  readonly onClose?: () => void;
}): ReactElement {
  const query = useSearchParams();
  const lenis = useLenis();
  // A bare `?create=<type>` resolves here, so opening needs no server request; other links arrive resolved.
  const pack = createRequestPack(query.get("create"));
  const current: CreateAgentRequest | null =
    onClose || needsServerRequest(query) ? request : pack ? { pack, brief: "" } : null;
  const key = current ? createRequestKey(current) : null;
  const [seen, setSeen] = useState<string | null>(key);
  const [opened, setOpened] = useState(current ? { key, request: current, id: 0 } : null);
  const [open, setOpen] = useState(current !== null);
  // While the wallet is used (funding, key approval) the dialog is non-modal, so the wallet's own window can take
  // clicks and focus; a modal dialog traps focus and blocks pointer events outside itself.
  const [walletStep, setWalletStep] = useState(false);
  // A new link opens the dialog. The same link stays closed after the user closes it, until the URL changes.
  if (key !== seen) {
    setSeen(key);
    if (current) {
      setOpened({ key, request: current, id: (opened?.id ?? 0) + 1 });
      setOpen(true);
      setWalletStep(false);
    }
  }

  // Lenis would keep scrolling the page behind the dialog (Docs/tech-stack.md → Lenis).
  useEffect(() => {
    if (!open || lenis === undefined) {
      return;
    }
    lenis.stop();
    return () => lenis.start();
  }, [open, lenis]);

  // Clears the link in the browser only. A server navigation here re-ran every read on the page behind the dialog;
  // a created agent reaches the list through its query, without re-rendering the page.
  function clearLink(): void {
    if (!onClose && seen !== null) {
      window.history.replaceState(null, "", "/agents");
    }
  }

  function close(): void {
    // The content stays mounted while it animates out; the next opening gets a fresh `id` and a fresh form.
    setOpen(false);
    clearLink();
    onClose?.();
  }

  return (
    <Dialog.Root open={open} modal={!walletStep} onOpenChange={(next) => (next ? undefined : close())}>
      {opened ? (
        <CreateAgentFlow
          key={opened.id}
          request={opened.request}
          launch={launch}
          modal={!walletStep}
          onClose={close}
          onCreated={() => {
            clearLink();
            setWalletStep(true);
          }}
        />
      ) : null}
    </Dialog.Root>
  );
}

interface CreateAgentFlowProps {
  readonly request: CreateAgentRequest;
  readonly launch: LaunchContext;
  readonly modal: boolean;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}

function CreateAgentFlow({ request, launch, modal, onClose, onCreated }: CreateAgentFlowProps): ReactElement {
  const formId = useId();
  const cache = useQueryClient();
  const [pack, setPack] = useState(request.pack);
  const [setups, setSetups] = useState<Partial<Record<Pack, SetupFields>>>(() => ({
    [request.pack]: {
      ...blankSetup(request.pack),
      text: request.brief,
    },
  }));
  const { text, budget: storedBudget, budgetTouched, policy } = setups[pack] ?? blankSetup(pack);
  const [phase, setPhase] = useState<DeployPhase>({ step: "setup" });
  // Retries reuse the save ID, so a lost reply recovers the same agent instead of creating another.
  const [saveId, setSaveId] = useState<string | null>(null);
  const busy = phase.step === "verifying" || phase.step === "saving";
  const item = AGENT_CATALOG[pack];

  function updateSetup(changes: Partial<SetupFields>): void {
    setSetups((current) => ({
      ...current,
      [pack]: { ...(current[pack] ?? blankSetup(pack)), ...changes },
    }));
  }

  const instructionBudget = useInstructionBudget(pack, text, storedBudget, budgetTouched, () => {
    updateSetup({ budgetTouched: false });
    invalidate();
  });
  const budget = instructionBudget.budget;

  const review = useStrategyReview({
    pack,
    text,
    budget,
    editing: phase.step === "setup",
    setPhase,
    setText: (next) => {
      updateSetup({ text: next });
      setSaveId(null);
    },
  });

  /** Switches type keeping the instructions and budget, so the user doesn't retype them. */
  function carryTo(next: Pack): void {
    setSetups((current) => ({
      ...current,
      [next]: { ...(current[next] ?? blankSetup(next)), text, budget: storedBudget, budgetTouched },
    }));
    setPack(next);
    invalidate();
  }

  function invalidate(): void {
    review.reset();
    setSaveId(null);
  }

  async function save(draft: StrategyDraft, verifyMs: number): Promise<void> {
    const limits = policySchema.safeParse(policy);
    if (!limits.success) {
      const message = limits.error.issues[0]?.message ?? "Check your limits.";
      setPhase({ step: "save_failed", draft, verifyMs, message });
      notify("error", message);
      return;
    }
    const id = saveId ?? crypto.randomUUID();
    setSaveId(id);
    setPhase({ step: "saving", draft, verifyMs, since: Date.now() });
    const started = performance.now();
    try {
      const result = await createAgentRequest({
        requestId: id,
        draftId: draft.id,
        policy: limits.data,
        agentId: null,
        expectedRevision: null,
        budget,
      });
      if (!result.ok) {
        setPhase({ step: "save_failed", draft, verifyMs, message: result.message });
        notify("error", result.message);
        return;
      }
      const saveMs = performance.now() - started;
      setPhase({ step: "done", draft, verifyMs, saveMs, ...result.value });
      onCreated();
      await cache.invalidateQueries({ queryKey: agentListKey(launch.ownerId) });
    } catch {
      const message = "The save could not be confirmed. Retry to recover it without creating a duplicate.";
      setPhase({ step: "save_failed", draft, verifyMs, message });
      notify("error", message);
    }
  }

  function deploy(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const instructions = strategyTextSchema.safeParse(text);
    if (!instructions.success) {
      notify("error", instructions.error.issues[0]?.message ?? "Check your instructions.");
      return;
    }
    const limits = policySchema.safeParse(policy);
    if (!limits.success) {
      notify("error", limits.error.issues[0]?.message ?? "Check your limits.");
      return;
    }
    // Several orders need DCA; Spot places one. Offer the switch instead of a failed verification.
    const orders = parseBudgetHint(text, true)?.count ?? 1;
    if (pack === "spot_trader" && orders > 1) {
      toast.warning(`Spot Trader places one order; these instructions place ${orders}.`, {
        action: { label: "Use DCA", onClick: () => carryTo("dca") },
      });
      return;
    }
    void review.verify();
  }

  const editSetup = (
    <Button variant="ghost" onClick={() => setPhase({ step: "setup" })}>
      Edit setup
    </Button>
  );

  function actions(): ReactElement {
    switch (phase.step) {
      case "setup":
        return (
          <>
            <Dialog.Close asChild>
              <Button variant="ghost">Cancel</Button>
            </Dialog.Close>
            <Button type="submit" form={formId} variant="primary" disabled={review.refining}>
              Continue
              <ArrowRight {...BUTTON_ICON} />
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
              Confirm and add funds
            </Button>
          </>
        );
      }
      case "verify_failed":
        return (
          <>
            {editSetup}
            <Button variant="primary" onClick={() => void review.verify()}>
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
        // Funding and Start run in the timeline above; these only leave the dialog.
        return (
          <>
            <Link
              href={`/agents/${phase.agentId}`}
              className="inline-flex h-10 items-center gap-1.5 rounded-sm px-3 text-body text-fg-muted transition-colors duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong pointer-coarse:h-11"
            >
              Open agent
              <ArrowRight {...BUTTON_ICON} />
            </Link>
            <Button variant="soft" onClick={onClose}>
              Close
            </Button>
          </>
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
        return launch.privateReady
          ? "Next: review the rules, add funds, then deploy."
          : "Funding and deploying are off here. Set WRENAI_LOCAL_EXECUTION=1 or use the Vercel app.";
      case "verifying":
      case "saving":
        return "Keep this open until it finishes.";
      case "review":
        return "Confirming reserves your budget. Then you add the funds and deploy.";
      case "verify_failed":
        return "Edit the setup, or retry.";
      case "save_failed":
        return "Retry uses the same request, so no duplicate is created.";
      case "done":
        return "Approve the deposit in your wallet. Deploy turns on when the funds arrive.";
      default: {
        const unhandled: never = phase;
        throw new Error(`Unhandled deploy phase: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  const rules =
    phase.step === "review" ? (
      <div className="flex flex-col gap-3 border-t border-line-card pt-3">
        <Badge tone="accent">
          <Check aria-hidden="true" size={12} />
          Model verified
        </Badge>
        <StrategySummary strategy={phase.draft.strategy} assets={phase.draft.assets} />
      </div>
    ) : null;

  return (
    <AgentSetupDialogFrame
      title={`New ${item.name}`}
      description={item.description}
      busy={busy}
      modal={modal}
      footer={
        <footer className="flex items-center gap-4 border-t border-line-card px-card py-3.5">
          <p title={note()} className="min-w-0 flex-1 truncate text-caption text-fg-subtle">
            {note()}
          </p>
          <div className="flex shrink-0 items-center gap-2">{actions()}</div>
        </footer>
      }
    >
      {phase.step === "setup" ? (
        <form id={formId} onSubmit={deploy}>
          <CreateAgentFields
            pack={pack}
            onPackChange={(next) => {
              setPack(next);
              invalidate();
            }}
            text={text}
            onTextChange={(next) => {
              updateSetup({ text: next });
              invalidate();
            }}
            budget={budget}
            onBudgetChange={(next) => {
              updateSetup({ budget: next, budgetTouched: true });
              invalidate();
            }}
            budgetNote={instructionBudget.note}
            policy={policy}
            onPolicyChange={(next) => {
              updateSetup({ policy: next });
              setSaveId(null);
            }}
            onRefine={() => void review.refine()}
            refining={review.refining}
            refineNote={review.refineNote}
          />
        </form>
      ) : (
        <m.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: "easeOut" }}
          className="flex flex-col gap-4"
        >
          <p title={text} className="line-clamp-2 text-caption text-fg-muted">
            {text}
          </p>
          <DeployTimeline
            phase={phase}
            budgeted={budget !== null}
            review={rules}
            launch={
              phase.step === "done" ? (
                <DeployLaunch
                  context={launch}
                  agent={{ id: phase.agentId, revision: phase.revision }}
                  publicRoute={"format" in phase.draft.strategy && usesPublicRoute(phase.draft.strategy)}
                  budget={budget}
                  onCancelled={onClose}
                />
              ) : null
            }
          />
        </m.div>
      )}
    </AgentSetupDialogFrame>
  );
}
