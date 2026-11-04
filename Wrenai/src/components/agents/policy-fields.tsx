"use client";

import { cloneElement, type ReactElement, useId } from "react";
import type { AgentPolicy } from "@/shared/agents";
import { parseUsd, usdInputSchema } from "@/shared/agents";
import { formatExactMicroUsd } from "@/shared/money";

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
  const tradeLimit = usdInputSchema.safeParse(policy.maxTradeUsd);
  const moneyFields = [
    { key: "budgetUsd", label: "Capital risk ceiling (USD)" },
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
    <div className="space-y-3">
      <p className="text-small text-fg-muted">
        Autonomous within your limits ·{" "}
        <span className="font-mono tabular-nums">
          {tradeLimit.success
            ? `${formatExactMicroUsd(parseUsd(tradeLimit.data))} per trade`
            : "set a per-trade limit"}
        </span>
        .
      </p>
      <details className="rounded-sm border border-line p-3">
        <summary className="cursor-pointer text-small">Risk limits</summary>
        <fieldset disabled={disabled} className="mt-4 grid min-w-0 gap-5 sm:grid-cols-2">
          <legend className="sr-only">Trading limits</legend>
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
          {policy.approvalMode !== "autonomous" ? (
            <label className="flex items-center gap-3 text-small sm:col-span-2">
              <input
                type="checkbox"
                checked={false}
                required
                onChange={() => onChange({ ...policy, approvalMode: "autonomous" })}
              />
              Allow autonomous execution within these limits
            </label>
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
          <label className="flex items-start gap-3 text-small sm:col-span-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={policy.allowRiskReducingExits === true}
              onChange={(event) => onChange({ ...policy, allowRiskReducingExits: event.target.checked })}
            />
            <span>
              Allow verified position-reducing exits after entry limits are reached. Exits still require owned
              tokens and fee/slippage limits.
            </span>
          </label>
        </fieldset>
      </details>
    </div>
  );
}
