"use client";

import type { ReactElement } from "react";
import type { AgentBudgetInput } from "@/shared/agent-budget";
import { isActiveAgentTool } from "@/shared/agent-scope";
import { agentTemplate } from "@/shared/agent-templates";
import { type AgentPolicy, type AgentSummary, PACKS, packSchema } from "@/shared/agents";
import { Field, PolicyFields, Select } from "./policy-fields";
import { TokenBudget } from "./token-budget";

type Pack = AgentSummary["pack"];

interface CreateAgentFieldsProps {
  readonly pack: Pack;
  /** A saved setup is bound to its type, so the type can't change. */
  readonly packLocked: boolean;
  readonly onPackChange: (pack: Pack) => void;
  readonly text: string;
  readonly onTextChange: (text: string) => void;
  readonly budget: AgentBudgetInput | null;
  readonly onBudgetChange: (budget: AgentBudgetInput | null) => void;
  readonly setupId: string | null;
  readonly policy: AgentPolicy;
  readonly onPolicyChange: (policy: AgentPolicy) => void;
}

/**
 * The create dialog's setup, top to bottom: type, strategy (opening on the type's preset), budget and risk limits.
 * One label style and one control height throughout; rows sit 20 px apart.
 */
export function CreateAgentFields({
  pack,
  packLocked,
  onPackChange,
  text,
  onTextChange,
  budget,
  onBudgetChange,
  setupId,
  policy,
  onPolicyChange,
}: CreateAgentFieldsProps): ReactElement {
  const template = agentTemplate(pack);
  return (
    <div className="flex flex-col gap-5">
      <Field label="Type">
        <Select
          disabled={packLocked}
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
      <div className="flex flex-col gap-1.5">
        <Field label="Strategy">
          <textarea
            minLength={20}
            maxLength={4000}
            required
            rows={3}
            value={text}
            onChange={(event) => onTextChange(event.target.value)}
            placeholder={template}
            className="field-sizing-content max-h-60 min-h-24 w-full resize-none rounded-sm border border-line bg-sunken px-3 py-2.5 text-body text-fg-strong placeholder:text-fg-subtle"
          />
        </Field>
        <div className="flex items-baseline justify-between gap-3 text-caption text-fg-subtle">
          <span>Edit the tokens and amounts to yours.</span>
          {template && text !== template ? (
            <button
              type="button"
              onClick={() => onTextChange(template)}
              className="shrink-0 cursor-pointer rounded-xs text-fg-muted underline-offset-4 transition-colors duration-200 ease-ios hover:text-fg-strong hover:underline"
            >
              Use preset
            </button>
          ) : null}
        </div>
      </div>
      <TokenBudget
        value={budget}
        onChange={onBudgetChange}
        disabled={false}
        {...(setupId ? { excludeId: setupId } : {})}
      />
      <PolicyFields policy={policy} onChange={onPolicyChange} disabled={false} />
    </div>
  );
}
