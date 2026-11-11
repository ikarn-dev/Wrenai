"use client";

import { LoaderCircle, PenLine } from "lucide-react";
import type { ReactElement } from "react";
import type { AgentBudgetInput } from "@/shared/agent-budget";
import { isActiveAgentTool } from "@/shared/agent-scope";
import { agentSetupProfile } from "@/shared/agent-templates";
import { type AgentPolicy, type AgentSummary, PACKS, packSchema } from "@/shared/agents";
import { Field, PolicyFields, Select } from "./policy-fields";
import { StrategyTemplates } from "./strategy-templates";
import { TokenBudget } from "./token-budget";

type Pack = AgentSummary["pack"];
const ICON = { size: 14, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;

interface CreateAgentFieldsProps {
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
}

/** The outcome of Refine and check, shown under the instructions. */
export interface RefineNote {
  readonly tone: "ok" | "warn";
  readonly text: string;
}

/**
 * The create dialog's setup includes the selected type's instructions, allocation and limits.
 * One label style and one control height throughout; rows sit 20 px apart.
 */
export function CreateAgentFields({
  pack,
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
}: CreateAgentFieldsProps): ReactElement {
  const setup = agentSetupProfile(pack);
  return (
    <div className="flex flex-col gap-5">
      <Field label="Type">
        <Select
          value={pack}
          onChange={(event) => {
            const parsed = packSchema.safeParse(event.target.value);
            if (parsed.success) {
              onPackChange(parsed.data);
            }
          }}
        >
          {Object.entries(PACKS)
            .filter(([value]) => isActiveAgentTool(value))
            .map(([value, item]) => (
              <option key={value} value={value}>
                {item.label}
              </option>
            ))}
        </Select>
      </Field>
      <div className="flex flex-col gap-3">
        <StrategyTemplates
          key={pack}
          templates={setup.templates}
          hasInstructions={Boolean(text.trim())}
          onApply={onTextChange}
        />
        <Field label={setup.instructions} hint={setup.guidance}>
          <textarea
            minLength={20}
            maxLength={4000}
            required
            rows={3}
            value={text}
            onChange={(event) => onTextChange(event.target.value)}
            placeholder="Write your instructions or apply a template."
            className="field-sizing-content max-h-60 min-h-24 w-full resize-none rounded-sm border border-line bg-sunken px-3 py-2.5 text-body text-fg-strong placeholder:text-fg-subtle"
          />
        </Field>
        <div className="flex items-start justify-between gap-3">
          <p
            role="status"
            className={`min-w-0 text-caption ${refineNote?.tone === "warn" ? "text-warn" : refineNote ? "text-accent-text" : "text-fg-subtle"}`}
          >
            {refineNote?.text ?? "Refine rewrites your text clearly and checks it before you deploy."}
          </p>
          <button
            type="button"
            onClick={onRefine}
            disabled={refining || text.trim().length < 20}
            aria-busy={refining}
            className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-3 text-small font-medium text-fg-strong ring-1 ring-line-strong/40 ring-inset transition-[background-color,scale] duration-200 ease-ios hover:bg-surface-3 active:scale-97 disabled:cursor-default disabled:text-fg-disabled motion-reduce:active:scale-100 pointer-coarse:h-11"
          >
            {refining ? (
              <LoaderCircle {...ICON} className="motion-safe:animate-spin" />
            ) : (
              <PenLine {...ICON} className="text-accent-text" />
            )}
            {refining ? "Checking…" : "Refine and check"}
          </button>
        </div>
      </div>
      {/* Each control restarts when the type changes. Sibling keys must differ, so each names its control. */}
      <TokenBudget
        key={`budget:${pack}`}
        label={setup.budget}
        value={budget}
        onChange={onBudgetChange}
        disabled={false}
      />
      <PolicyFields
        key={`limits:${pack}`}
        pack={pack}
        policy={policy}
        onChange={onPolicyChange}
        disabled={false}
      />
    </div>
  );
}
