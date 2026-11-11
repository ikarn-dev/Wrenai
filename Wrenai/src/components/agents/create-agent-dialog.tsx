"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useLenis } from "lenis/react";
import { ArrowRight, Check, LoaderCircle, X } from "lucide-react";
import { m } from "motion/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Dialog } from "radix-ui";
import { type FormEvent, type ReactElement, useEffect, useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AgentBudgetInput } from "@/shared/agent-budget";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import {
  type CreateAgentRequest,
  createRequestKey,
  createRequestPack,
  needsServerRequest,
} from "@/shared/agent-create-request";
import { usesPublicRoute } from "@/shared/agent-instructions";
import { agentSetupProfile } from "@/shared/agent-templates";
import {
  type AgentPolicy,
  type AgentSummary,
  DEFAULT_POLICY,
  policySchema,
  type StrategyDraft,
  strategyTextSchema,
} from "@/shared/agents";
import { agentListKey } from "./agents-section";
import { AgentAvatar } from "./avatar";
import { CreateAgentFields } from "./create-agent-fields";
import { DeployLaunch, type LaunchContext } from "./deploy-launch";
import { type DeployPhase, DeployTimeline } from "./deploy-timeline";
import { createAgentRequest } from "./review-api";
import { StrategySummary } from "./strategy-summary";
import { useStrategyReview } from "./use-strategy-review";

const BUTTON_ICON = { size: 18, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;
const EYEBROW = "font-mono text-eyebrow uppercase text-fg-muted";

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
  readonly policy: AgentPolicy;
}

function blankSetup(pack: Pack): SetupFields {
  return { text: "", budget: null, policy: initialPolicy(pack) };
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
  const { text, budget, policy } = setups[pack] ?? blankSetup(pack);
  const [phase, setPhase] = useState<DeployPhase>({ step: "setup" });
  const [formError, setFormError] = useState<string | null>(null);
  // Retries reuse the save ID, so a lost reply recovers the same agent instead of creating another.
  const [saveId, setSaveId] = useState<string | null>(null);
  const busy = phase.step === "verifying" || phase.step === "saving";
  const item = AGENT_CATALOG[pack];
  const setup = agentSetupProfile(pack);

  function updateSetup(changes: Partial<SetupFields>): void {
    setSetups((current) => ({
      ...current,
      [pack]: { ...(current[pack] ?? blankSetup(pack)), ...changes },
    }));
  }

  const review = useStrategyReview({
    pack,
    text,
    budget,
    setPhase,
    setText: (next) => {
      updateSetup({ text: next });
      setSaveId(null);
    },
  });

  function invalidate(): void {
    review.reset();
    setSaveId(null);
    setFormError(null);
  }

  async function save(draft: StrategyDraft, verifyMs: number): Promise<void> {
    const limits = policySchema.safeParse(policy);
    if (!limits.success) {
      const message = limits.error.issues[0]?.message ?? "Check your limits.";
      setPhase({ step: "save_failed", draft, verifyMs, message });
      return;
    }
    const id = saveId ?? crypto.randomUUID();
    setSaveId(id);
    setPhase({ step: "saving", draft, verifyMs });
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
        return;
      }
      const saveMs = performance.now() - started;
      setPhase({ step: "done", draft, verifyMs, saveMs, ...result.value });
      onCreated();
      await cache.invalidateQueries({ queryKey: agentListKey(launch.ownerId) });
    } catch {
      const message = "The save could not be confirmed. Retry to recover it without creating a duplicate.";
      setPhase({ step: "save_failed", draft, verifyMs, message });
    }
  }

  function deploy(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const instructions = strategyTextSchema.safeParse(text);
    if (!instructions.success) {
      setFormError(instructions.error.issues[0]?.message ?? "Check your instructions.");
      return;
    }
    const limits = policySchema.safeParse(policy);
    if (!limits.success) {
      setFormError(limits.error.issues[0]?.message ?? "Check your limits.");
      return;
    }
    setFormError(null);
    const checked = review.checkedDraft();
    if (checked) {
      setPhase({ step: "review", ...checked });
      return;
    }
    void review.verify();
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
      <div className="flex flex-col gap-3 rounded-md bg-sunken p-4">
        <div className="flex items-center justify-between gap-3">
          <span className={EYEBROW}>Parsed rules</span>
          <Badge tone="accent">
            <Check aria-hidden="true" size={12} />
            Model verified
          </Badge>
        </div>
        <StrategySummary strategy={phase.draft.strategy} assets={phase.draft.assets} />
      </div>
    ) : null;

  return (
    <Dialog.Portal>
      {/* Radix renders no overlay for a non-modal dialog, so the scrim stays as a plain layer under the wallet. */}
      {modal ? (
        <Dialog.Overlay className="dialog-scrim fixed inset-0 z-40 bg-bg/80" />
      ) : (
        <div aria-hidden="true" className="fixed inset-0 z-40 bg-bg/80" />
      )}
      <Dialog.Content
        // Outside clicks never close it, so a stray click can't discard the setup. Escape and Close do, except
        // while a step runs, so its result has somewhere to show.
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => (busy ? event.preventDefault() : undefined)}
        className="dialog-panel fixed inset-x-gutter top-1/2 z-50 mx-auto flex max-h-[calc(100dvh-2rem)] max-w-xl -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-surface-2 shadow-float"
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
                  updateSetup({ budget: next });
                  invalidate();
                }}
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
              className="flex flex-col gap-6"
            >
              <div className="flex flex-col gap-1.5 rounded-md bg-sunken p-4">
                <span className={EYEBROW}>{setup.instructions}</span>
                <p className="line-clamp-3 whitespace-pre-line text-small text-fg">{text}</p>
              </div>
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
