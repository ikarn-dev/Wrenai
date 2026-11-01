"use client";

import { cloneElement, type ReactElement, useId } from "react";
import { type AgentPolicy, approvalSchema } from "@/shared/agents";
import { APPROVAL_LABELS } from "./strategy-summary";

export const INPUT_CLASS =
  "h-11 w-full rounded-sm border border-line bg-surface-2 px-3 text-body text-fg-strong placeholder:text-fg-subtle disabled:opacity-60";
export function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactElement<{ readonly id?: string; readonly "aria-describedby"?: string }>;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor={id} className="text-small text-fg">
        {label}
      </label>
      {cloneElement(children, hint ? { id, "aria-describedby": `${id}-hint` } : { id })}
      {hint ? (
        <span id={`${id}-hint`} className="text-caption text-fg-subtle">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

interface PolicyFieldsProps {
  readonly policy: AgentPolicy;
  readonly onChange: (policy: AgentPolicy) => void;
  readonly disabled: boolean;
}
export function PolicyFields({ policy, onChange, disabled }: PolicyFieldsProps): ReactElement {
  const moneyFields = [
    { key: "budgetUsd", label: "Agent budget (USD)" },
    { key: "maxTradeUsd", label: "Maximum per trade (USD)" },
    { key: "dailyCapUsd", label: "24-hour spending cap (USD)" },
  ] as const;
  const numericFields = [
    { key: "maxSlippageBps", label: "Slippage cap (basis points)", min: 1, max: 500 },
    { key: "maxProviderFeeBps", label: "Partner fee cap (basis points)", min: 0, max: 2000 },
    { key: "maxTradesPerHour", label: "Maximum trades per hour", min: 1, max: 60 },
    { key: "cooldownSeconds", label: "Cooldown (seconds)", min: 0, max: 86400 },
  ] as const;
  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-5 sm:grid-cols-2">
      <legend className="mb-5 text-h3 text-fg-strong">Your trading limits</legend>
      {moneyFields.map(({ key, label }) => (
        <Field key={key} label={label}>
          <input
            className={`${INPUT_CLASS} font-mono tabular-nums`}
            inputMode="decimal"
            required
            value={policy[key]}
            onChange={(event) => onChange({ ...policy, [key]: event.target.value })}
          />
        </Field>
      ))}
      <Field label="Approval mode">
        <select
          className={INPUT_CLASS}
          value={policy.approvalMode}
          onChange={(event) => {
            const mode = approvalSchema.safeParse(event.target.value);
            if (mode.success) {
              onChange({ ...policy, approvalMode: mode.data });
            }
          }}
        >
          {Object.entries(APPROVAL_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      {policy.approvalMode === "above_size" ? (
        <Field label="Ask above (USD)">
          <input
            className={`${INPUT_CLASS} font-mono tabular-nums`}
            inputMode="decimal"
            required
            value={policy.approvalThresholdUsd}
            onChange={(event) => onChange({ ...policy, approvalThresholdUsd: event.target.value })}
          />
        </Field>
      ) : null}
      {numericFields.map(({ key, label, min, max }) => (
        <Field key={key} label={label}>
          <input
            type="number"
            step="1"
            min={min}
            max={max}
            required
            className={`${INPUT_CLASS} font-mono tabular-nums`}
            value={Number.isNaN(policy[key]) ? "" : policy[key]}
            onChange={(event) => onChange({ ...policy, [key]: event.target.valueAsNumber })}
          />
        </Field>
      ))}
      <p className="text-caption text-fg-subtle sm:col-span-2">
        100 basis points = 1%. Only you can change these limits. A budget does not deposit or move funds.
      </p>
    </fieldset>
  );
}
