"use client";

import { LoaderCircle, PenLine } from "lucide-react";
import { type ReactElement, type ReactNode, useId } from "react";
import type { AgentBudgetInput } from "@/shared/agent-budget";
import { isActiveAgentTool } from "@/shared/agent-scope";
import { agentSetupProfile } from "@/shared/agent-templates";
import { type AgentPolicy, type AgentSummary, PACKS, packSchema } from "@/shared/agents";
import { PolicyFields, Select } from "./policy-fields";
import { StrategyTemplates } from "./strategy-templates";
import { TokenBudget } from "./token-budget";

type Pack = AgentSummary["pack"];
const ICON = { size: 14, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;

interface CreateAgentFieldsProps {
  readonly allocation?: ReactNode;
  readonly limits?: ReactNode;
  readonly allowedTools?: readonly string[];
  readonly templates?: ReturnType<typeof agentSetupProfile>["templates"];
  readonly guidance?: string;
  readonly pack: Pack;
  readonly onPackChange: (pack: Pack) => void;
  readonly text: string;
  readonly onTextChange: (text: string) => void;
  readonly budget: AgentBudgetInput | null;
  readonly onBudgetChange: (budget: AgentBudgetInput | null) => void;
  readonly policy: AgentPolicy;
  readonly onPolicyChange: (policy: AgentPolicy) => void;
  readonly onRefine: () => void;
  readonly refining: boolean;
  readonly refineNote: RefineNote | null;
  /** Where the budget came from when the instructions set it, or how to set it from them again. */
  readonly budgetNote?: BudgetNote | null;
}

export interface BudgetNote {
  readonly text: string;
  /** Present when the user changed the budget: puts back the one the instructions imply. */
  readonly onApply: (() => void) | null;
}

/** The outcome of Refine, shown under the instructions. */
export interface RefineNote {
  readonly tone: "ok" | "warn";
  readonly text: string;
}

/** The budget's source line: set from the instructions, or a link to set it from them again. */
export function BudgetNoteLine({ note }: { readonly note: BudgetNote }): ReactElement {
  return (
    <p role="status" className="flex flex-wrap items-baseline gap-x-2 text-caption text-fg-muted">
      <span>{note.text}</span>
      {note.onApply ? (
        <button
          type="button"
          onClick={note.onApply}
          className="cursor-pointer rounded-xs font-medium text-accent-text underline-offset-4 hover:underline"
        >
          Use it
        </button>
      ) : null}
    </p>
  );
}

/**
 * The create dialog's setup includes the selected type's instructions, allocation and limits.
 * One label style and one control height throughout; rows sit 20 px apart.
 */
export function CreateAgentFields({
  pack,
  allocation,
  limits,
  allowedTools,
  templates,
  guidance,
  onPackChange,
  text,
  onTextChange,
  budget,
  onBudgetChange,
  policy,
  onPolicyChange,
  onRefine,
  refining,
  refineNote,
  budgetNote = null,
}: CreateAgentFieldsProps): ReactElement {
  const instructionsId = useId();
  const setup = agentSetupProfile(pack);
  const hint = guidance ?? setup.guidance;
  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Strategy" className="flex flex-col gap-4">
        {/* Type sits on one row with its label, so the select is only as wide as its longest name. */}
        <div className="flex items-center justify-between gap-4">
          <label htmlFor={`${instructionsId}-type`} className="text-small text-fg-muted">
            Type
          </label>
          <Select
            id={`${instructionsId}-type`}
            className="w-64 max-w-full"
            value={pack}
            onChange={(event) => {
              const parsed = packSchema.safeParse(event.target.value);
              if (parsed.success) {
                onPackChange(parsed.data);
              }
            }}
          >
            {Object.entries(PACKS)
              .filter(
                ([value]) => isActiveAgentTool(value) && (!allowedTools || allowedTools.includes(value)),
              )
              .map(([value, item]) => (
                <option key={value} value={value}>
                  {item.label}
                </option>
              ))}
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <label htmlFor={instructionsId} className="text-small text-fg-muted">
              {setup.instructions}
            </label>
            <StrategyTemplates
              key={pack}
              templates={templates ?? setup.templates}
              hasInstructions={Boolean(text.trim())}
              onApply={onTextChange}
            />
          </div>
          <textarea
            id={instructionsId}
            aria-describedby={`${instructionsId}-hint`}
            minLength={20}
            maxLength={4000}
            required
            rows={3}
            value={text}
            onChange={(event) => onTextChange(event.target.value)}
            placeholder="Write your instructions or apply a template."
            className="field-sizing-content max-h-60 min-h-24 w-full resize-none rounded-sm bg-sunken px-3 py-2.5 text-small text-fg-strong ring-1 ring-transparent ring-inset transition-shadow duration-200 ease-ios placeholder:text-fg-subtle hover:ring-line focus-visible:outline-1 focus-visible:outline-offset-0"
          />
          <div className="flex items-start justify-between gap-3">
            <p
              id={`${instructionsId}-hint`}
              role="status"
              className={`min-w-0 pt-1.5 text-caption ${refineNote?.tone === "warn" ? "text-warn" : refineNote ? "text-accent-text" : "text-fg-subtle"}`}
            >
              {refineNote?.text ?? hint}
            </p>
            <button
              type="button"
              onClick={onRefine}
              disabled={refining || text.trim().length < 20}
              aria-busy={refining}
              title="Rewrite your instructions more clearly. Continue checks them."
              className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-2.5 text-small font-medium text-fg transition-colors duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong disabled:cursor-default disabled:text-fg-disabled pointer-coarse:h-11"
            >
              {refining ? (
                <LoaderCircle {...ICON} className="motion-safe:animate-spin" />
              ) : (
                <PenLine {...ICON} className="text-accent-text" />
              )}
              {refining ? "Refining…" : "Refine"}
            </button>
          </div>
        </div>
      </section>
      <section aria-label="Budget and limits" className="flex flex-col gap-4 border-t border-line pt-5">
        {/* Each control restarts when the type changes. Sibling keys must differ, so each names its control. */}
        {allocation !== undefined ? (
          allocation
        ) : (
          <div className="flex flex-col gap-1.5">
            <TokenBudget
              key={`budget:${pack}`}
              label={setup.budget}
              value={budget}
              onChange={onBudgetChange}
              disabled={false}
            />
            {budgetNote ? <BudgetNoteLine note={budgetNote} /> : null}
          </div>
        )}
        {limits !== undefined ? (
          limits
        ) : (
          <PolicyFields
            key={`limits:${pack}`}
            pack={pack}
            policy={policy}
            onChange={onPolicyChange}
            disabled={false}
          />
        )}
      </section>
    </div>
  );
}
