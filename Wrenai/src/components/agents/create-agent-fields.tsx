"use client";

import type { ReactElement } from "react";
import type { AgentBudgetInput } from "@/shared/agent-budget";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import { isActiveAgentTool } from "@/shared/agent-scope";
import { type AgentPolicy, type AgentSummary, PACKS, packSchema } from "@/shared/agents";
import { Field, INPUT_CLASS, PolicyFields } from "./policy-fields";
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

/** The create dialog's setup: type, strategy text, token budget and risk limits. */
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
  return (
    <div className="flex flex-col gap-5">
      <Field label="Agent type">
        <select
          className={INPUT_CLASS}
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
        </select>
      </Field>
      <div className="flex flex-col gap-2">
        <Field
          label="What should this agent do?"
          hint="Use the exact tokens, amounts and price levels. No name needed."
        >
          <textarea
            minLength={20}
            maxLength={4000}
            required
            rows={5}
            value={text}
            onChange={(event) => onTextChange(event.target.value)}
            placeholder={AGENT_CATALOG[pack].prompt}
            className="w-full resize-y rounded-sm border border-line-strong bg-sunken p-3 text-body text-fg-strong placeholder:text-fg-subtle"
          />
        </Field>
        <button
          type="button"
          className="w-fit cursor-pointer rounded-xs text-small text-fg-muted underline underline-offset-4 transition-colors duration-200 ease-ios hover:text-fg-strong"
          onClick={() => onTextChange(AGENT_CATALOG[pack].fields.map((field) => `${field}: `).join("\n"))}
        >
          Use setup guide
        </button>
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
