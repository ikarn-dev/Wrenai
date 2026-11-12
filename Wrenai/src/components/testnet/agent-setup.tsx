"use client";
import { ArrowRight, Rocket } from "lucide-react";
import { m } from "motion/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Dialog } from "radix-ui";
import type { ReactElement } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { BudgetNoteLine, CreateAgentFields, type RefineNote } from "@/components/agents/create-agent-fields";
import { INPUT_CLASS, Select } from "@/components/agents/policy-fields";
import { AgentSetupDialogFrame } from "@/components/agents/setup-dialog-frame";
import { useEarlyCheck } from "@/components/agents/use-early-check";
import { Button } from "@/components/ui/button";
import type { AgentBudgetInput } from "@/shared/agent-budget";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import { DEFAULT_POLICY, strategyRefinementSchema } from "@/shared/agents";
import { parseBudgetHint } from "@/shared/budget-hint";
import {
  type TestnetLocation,
  type TestnetRule,
  testnetAsset,
  testnetReviewSchema,
  tokenText,
} from "@/shared/testnet";
import { testnetAgentToolSchema } from "@/shared/testnet-agents";
import { TEMPLATES } from "./agent-templates";
import { TestnetApiError, testnetApi } from "./api";
import { useTestnetData } from "./data-provider";
import { testnetInstructionBudget } from "./instruction-budget";
import { type TestnetPhase, TestnetSetupTimeline } from "./setup-timeline";

type Tool = (typeof testnetAgentToolSchema.options)[number];
const FOOTER_ICON = { size: 16, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;
export function TestnetAgentSetup(): ReactElement | null {
  const params = useSearchParams();
  const selected = params.get("create");
  const parsed = testnetAgentToolSchema.safeParse(selected);
  const tool = selected === "agent" ? "spot_trader" : parsed.success ? parsed.data : null;
  const [seen, setSeen] = useState(selected);
  const [opened, setOpened] = useState(tool ? { tool, id: 0 } : null);
  if (selected !== seen) {
    setSeen(selected);
    if (tool) {
      setOpened({ tool, id: (opened?.id ?? 0) + 1 });
    }
  }
  const close = (): void => {
    const url = new URL(window.location.href);
    url.searchParams.delete("create");
    window.history.replaceState(null, "", url);
  };
  return (
    <Dialog.Root
      open={Boolean(tool)}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      {opened ? <TestnetAgentSetupFlow key={opened.id} initialTool={opened.tool} close={close} /> : null}
    </Dialog.Root>
  );
}
function TestnetAgentSetupFlow({
  initialTool,
  close,
}: {
  readonly initialTool: Tool;
  readonly close: () => void;
}): ReactElement | null {
  const { data, refresh } = useTestnetData();
  const [tool, setTool] = useState(initialTool),
    [text, setText] = useState("");
  const [storedBudget, setBudget] = useState<AgentBudgetInput | null>(null),
    [storedLocation, setLocation] = useState<TestnetLocation>("intents"),
    // Until the user picks a budget, it follows the instructions (parsed locally, no AI).
    [budgetTouched, setBudgetTouched] = useState(false),
    [refining, setRefining] = useState(false),
    [refineNote, setRefineNote] = useState<RefineNote | null>(null);
  // The review's sealed verification travels back on deploy, so Proof can show this exact rule's receipt.
  const [reviewToken, setReviewToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<TestnetPhase>({ step: "setup" });
  const [requestId, setRequestId] = useState<string | null>(null);
  const busy = phase.step === "verifying" || phase.step === "deploying";
  const reset = (): void => {
    setPhase({ step: "setup" });
    setReviewToken(null);
    setRequestId(null);
  };
  const available = data?.balances.filter((b) => BigInt(b.units) > BigInt(b.reserved)) ?? [];
  const instructionBudget = testnetInstructionBudget(
    text,
    tool,
    data?.balances ?? [],
    { budget: storedBudget, location: storedLocation },
    budgetTouched,
    () => {
      setBudgetTouched(false);
      reset();
    },
  );
  const budget = instructionBudget.budget,
    location = instructionBudget.location;
  /** The user's own budget choice, which stops it following the instructions. */
  const chooseBudget = (next: AgentBudgetInput | null, nextLocation: TestnetLocation = location): void => {
    setBudget(next);
    setLocation(nextLocation);
    setBudgetTouched(true);
    reset();
  };
  /** Refine only rewrites the text; Continue runs the verified check. */
  async function refine(): Promise<void> {
    setRefining(true);
    setRefineNote(null);
    try {
      const reply = strategyRefinementSchema.parse(
        await testnetApi({
          command: "refine_agent",
          setup: {
            tool,
            text,
            budgetAssetId: budget?.assetId ?? null,
            budgetAmount: budget?.amount.trim() || null,
          },
        }),
      );
      setText(reply.text);
      reset();
      setRefineNote(
        reply.note
          ? { tone: "warn", text: reply.note }
          : { tone: "ok", text: "Rewritten. Review it, then continue." },
      );
    } catch (e) {
      setRefineNote({ tone: "warn", text: e instanceof Error ? e.message : "Couldn’t refine right now." });
    } finally {
      setRefining(false);
    }
  }
  const selectedBalance = available.find((b) => b.assetId === budget?.assetId && b.location === location);
  const orders = parseBudgetHint(text, true)?.count ?? 1;
  const reviewInput = budget ? { tool, text, budget: { ...budget, location } } : null;
  // The verified check starts on its own once these inputs settle, so Continue usually finds it done.
  const reviewKey =
    phase.step === "setup" &&
    !refining &&
    reviewInput !== null &&
    selectedBalance !== undefined &&
    reviewInput.budget.amount.trim() !== "" &&
    text.trim().length >= 20 &&
    !/\{\{[^}]+\}\}/.test(text) &&
    (tool === "dca" || orders <= 1) &&
    data?.owner.kind === "guest"
      ? JSON.stringify(reviewInput)
      : null;
  const early = useEarlyCheck(reviewKey, async (signal) =>
    testnetReviewSchema.parse(await testnetApi({ command: "review_agent", setup: reviewInput }, "", signal)),
  );
  /** The check for exactly these inputs: the early one when it ran or is running, otherwise a fresh request. */
  async function checked(
    input: NonNullable<typeof reviewInput>,
  ): Promise<{ readonly reviewed: z.infer<typeof testnetReviewSchema>; readonly since: number }> {
    const check = early.take(JSON.stringify(input));
    if (check) {
      setPhase({ step: "verifying", since: check.startedAt });
      const settled = await check.result;
      if (settled.ok) {
        return { reviewed: settled.value, since: check.startedAt };
      }
      // A refusal of the request itself (400) is the answer; an outage or limit gets one fresh try.
      if (settled.error instanceof TestnetApiError && settled.error.status === 400) {
        throw settled.error;
      }
    }
    const since = Date.now();
    setPhase({ step: "verifying", since });
    const reviewed = testnetReviewSchema.parse(await testnetApi({ command: "review_agent", setup: input }));
    return { reviewed, since };
  }
  async function review(): Promise<void> {
    if (/\{\{[^}]+\}\}/.test(text)) {
      toast.error("Fill in the template fields before continuing.");
      return;
    }
    if (!reviewInput || !selectedBalance) {
      toast.error("Choose an available token and budget.");
      return;
    }
    // Several orders need DCA; the other types place one. Offer the switch instead of a failed check.
    if (tool !== "dca" && orders > 1) {
      toast.warning(`${AGENT_CATALOG[tool].name} places one order; these instructions place ${orders}.`, {
        action: { label: "Use DCA", onClick: () => setTool("dca") },
      });
      return;
    }
    try {
      const { reviewed, since } = await checked(reviewInput);
      setReviewToken(reviewed.review);
      setPhase({ step: "review", rule: reviewed.rule, verifyMs: Date.now() - since });
    } catch (e) {
      setPhase({ step: "verify_failed" });
      toast.error(e instanceof Error ? e.message : "The strategy could not be checked.");
    }
  }
  async function deploy(rule: TestnetRule, verifyMs: number): Promise<void> {
    const id = requestId ?? crypto.randomUUID();
    setRequestId(id);
    setPhase({ step: "deploying", rule, verifyMs, since: Date.now() });
    const started = performance.now();
    try {
      const created = z.object({ id: z.uuid() }).parse(
        await testnetApi({
          command: "agent",
          requestId: id,
          rule,
          ...(reviewToken ? { review: reviewToken } : {}),
        }),
      );
      setPhase({ step: "done", rule, verifyMs, deployMs: performance.now() - started, agentId: created.id });
      toast.success("Agent deployed and running.");
      await refresh();
    } catch (e) {
      setPhase({ step: "deploy_failed", rule, verifyMs });
      toast.error(e instanceof Error ? e.message : "Deployment could not be confirmed. Retry to recover it.");
    }
  }
  function actions(): ReactElement {
    const edit = (
      <Button variant="ghost" onClick={reset}>
        Edit setup
      </Button>
    );
    switch (phase.step) {
      case "setup":
      case "verifying":
        return (
          <>
            <Button variant="ghost" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={data?.owner.kind !== "guest" || refining}
              onClick={() => {
                void review();
              }}
            >
              Continue
              <ArrowRight {...FOOTER_ICON} />
            </Button>
          </>
        );
      case "verify_failed":
        return (
          <>
            {edit}
            <Button
              variant="primary"
              onClick={() => {
                void review();
              }}
            >
              Retry
            </Button>
          </>
        );
      case "review":
      case "deploying":
      case "deploy_failed": {
        const { rule, verifyMs } = phase;
        return (
          <>
            {phase.step === "deploying" ? null : edit}
            <Button
              variant="primary"
              busy={phase.step === "deploying"}
              onClick={() => {
                void deploy(rule, verifyMs);
              }}
            >
              <Rocket {...FOOTER_ICON} />
              {phase.step === "deploy_failed" ? "Retry deploy" : "Deploy agent"}
            </Button>
          </>
        );
      }
      case "done":
        return (
          <Button variant="soft" onClick={close}>
            Close
          </Button>
        );
      default: {
        const unhandled: never = phase;
        throw new Error(`Unhandled setup phase: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  // One row like mainnet's budget: the held token, then its amount, with the instructions' note under them.
  const allocation = (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 text-small text-fg-muted">Budget</legend>
      <div className="flex min-w-0 gap-2">
        <Select
          aria-label="Budget token"
          className="min-w-0 flex-1"
          value={selectedBalance ? `${location}|${budget?.assetId}` : ""}
          onChange={(e) => {
            const value = available.find((b) => `${b.location}|${b.assetId}` === e.target.value);
            if (value) {
              chooseBudget({ assetId: value.assetId, amount: "" }, value.location);
            }
          }}
        >
          <option value="">Choose a held token</option>
          {available.map((b) => (
            <option key={`${b.location}:${b.assetId}`} value={`${b.location}|${b.assetId}`}>
              {testnetAsset(b.assetId).symbol} · {b.location === "intents" ? "Public Intents" : "Wallet"} ·{" "}
              {tokenText((BigInt(b.units) - BigInt(b.reserved)).toString(), testnetAsset(b.assetId).decimals)}{" "}
              available
            </option>
          ))}
        </Select>
        {budget ? (
          // INPUT_CLASS is full width, so the fixed width sits on a wrapper; on the input itself it lost to w-full
          // and squeezed the token select.
          <span className="w-36 shrink-0">
            <input
              aria-label={`Amount in ${testnetAsset(budget.assetId).symbol}`}
              className={`${INPUT_CLASS} font-mono tabular-nums`}
              value={budget.amount}
              placeholder="0.00"
              inputMode="decimal"
              autoComplete="off"
              onChange={(e) => {
                chooseBudget({ ...budget, amount: e.target.value });
              }}
            />
          </span>
        ) : null}
      </div>
      {instructionBudget.note ? <BudgetNoteLine note={instructionBudget.note} /> : null}
    </fieldset>
  );
  return (
    <AgentSetupDialogFrame
      title={`New ${tool === "private_payments" ? "Payments Agent" : AGENT_CATALOG[tool].name}`}
      description="Review the rules and allocate test funds before deployment."
      busy={busy}
      footer={
        <footer className="flex items-center gap-4 border-t border-line-card px-card py-3.5">
          <p className="min-w-0 flex-1 truncate text-caption text-fg-subtle">
            {phase.step === "done"
              ? "It runs within this guest session."
              : "Test funds only. Runs within this guest session."}
          </p>
          <div className="flex shrink-0 items-center gap-2">{actions()}</div>
        </footer>
      }
    >
      {data?.owner.kind !== "guest" ? (
        <p className="mb-4 text-small text-fg-muted">
          Use guest test funds for autonomous agents. Connected wallets support manual payments and swaps.
        </p>
      ) : null}
      {phase.step !== "setup" ? (
        <m.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: "easeOut" }}
          className="flex flex-col gap-4"
        >
          <p title={text} className="line-clamp-2 text-caption text-fg-muted">
            {text}
          </p>
          <TestnetSetupTimeline
            phase={phase}
            done={
              phase.step === "done" ? (
                <Link
                  href={`/testnet/agents/${phase.agentId}`}
                  onClick={close}
                  className="inline-flex items-center gap-1.5 rounded-xs text-small font-medium text-accent-text underline-offset-4 hover:underline"
                >
                  Open agent
                  <ArrowRight {...FOOTER_ICON} size={14} />
                </Link>
              ) : null
            }
          />
        </m.div>
      ) : (
        <CreateAgentFields
          pack={tool}
          allowedTools={testnetAgentToolSchema.options}
          onPackChange={(next) => {
            const valid = testnetAgentToolSchema.safeParse(next);
            if (valid.success) {
              setTool(valid.data);
              setText("");
              reset();
            }
          }}
          text={text}
          onTextChange={(next) => {
            setText(next);
            setRefineNote(null);
            reset();
          }}
          budget={budget}
          onBudgetChange={(next) => chooseBudget(next)}
          policy={DEFAULT_POLICY}
          onPolicyChange={() => undefined}
          onRefine={() => {
            void refine();
          }}
          refining={refining}
          refineNote={refineNote}
          allocation={allocation}
          limits={null}
          templates={TEMPLATES[tool]}
          guidance="Name the amount and condition. Test tokens only."
        />
      )}
    </AgentSetupDialogFrame>
  );
}
