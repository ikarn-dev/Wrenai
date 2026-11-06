"use client";

import { ChevronDown } from "lucide-react";
import { type ComponentPropsWithoutRef, cloneElement, type ReactElement, useId } from "react";
import type { AgentPolicy } from "@/shared/agents";
import { parseUsd, usdInputSchema } from "@/shared/agents";
import { formatExactMicroUsd } from "@/shared/money";

// Form controls for agent setup (Docs/DESIGN.md → Components → Inputs): a sunken fill so the control reads on the
// dialog's surface-2, a quiet line border and the 40 px control height (44 px on touch). Labels use the Label role
// (small, fg-muted) in sentence case, 6 px above their control.
export const INPUT_CLASS =
  "h-10 w-full rounded-sm border border-line bg-sunken px-3 text-body text-fg-strong placeholder:text-fg-subtle disabled:text-fg-disabled pointer-coarse:h-11";
const LABEL = "text-small text-fg-muted";
const ICON = { size: 16, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;

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
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={LABEL}>
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

/** A native select drawn like the inputs, with one chevron instead of the platform arrow. */
export function Select({
  className = "",
  ...props
}: Omit<ComponentPropsWithoutRef<"select">, "className"> & { readonly className?: string }): ReactElement {
  return (
    <span className={`relative flex min-w-0 ${className}`}>
      <select {...props} className={`${INPUT_CLASS} cursor-pointer appearance-none truncate pr-9`} />
      <ChevronDown
        {...ICON}
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-fg-muted"
      />
    </span>
  );
}

const MONEY_FIELDS = [
  { key: "budgetUsd", label: "Risk ceiling, USD" },
  { key: "maxTradeUsd", label: "Per trade, USD" },
  { key: "dailyCapUsd", label: "Per 24 hours, USD" },
] as const;
const COUNT_FIELDS = [
  { key: "maxSlippageBps", label: "Slippage, bps", min: 1, max: 500 },
  { key: "maxProviderFeeBps", label: "Partner fee, bps", min: 0, max: 2000 },
  { key: "maxTradesPerHour", label: "Trades per hour", min: 1, max: 60 },
  { key: "cooldownSeconds", label: "Cooldown, seconds", min: 0, max: 86400 },
] as const;

/** The two limits that matter most at a glance, shown on the collapsed row. Display only. */
function limitsSummary(policy: AgentPolicy): string {
  const trade = usdInputSchema.safeParse(policy.maxTradeUsd);
  const perTrade = trade.success
    ? `${formatExactMicroUsd(parseUsd(trade.data))} per trade`
    : "Set a per-trade limit";
  return Number.isNaN(policy.maxSlippageBps)
    ? perTrade
    : `${perTrade} · ${policy.maxSlippageBps / 100}% slippage`;
}

interface PolicyFieldsProps {
  readonly policy: AgentPolicy;
  readonly onChange: (policy: AgentPolicy) => void;
  readonly disabled: boolean;
}

/** The user's risk limits as one collapsed row (its summary on the right) that opens into a two-column form. */
export function PolicyFields({ policy, onChange, disabled }: PolicyFieldsProps): ReactElement {
  return (
    <details className="group rounded-sm border border-line">
      <summary className="flex h-10 cursor-pointer list-none items-center justify-between gap-3 px-3 pointer-coarse:h-11 [&::-webkit-details-marker]:hidden">
        <span className="text-small text-fg">Risk limits</span>
        <span className="flex min-w-0 items-center gap-2 text-small text-fg-muted">
          <span className="truncate font-mono tabular-nums">{limitsSummary(policy)}</span>
          <ChevronDown
            {...ICON}
            className="shrink-0 transition-transform duration-200 ease-ios group-open:rotate-180"
          />
        </span>
      </summary>
      <fieldset disabled={disabled} className="grid min-w-0 gap-4 border-t border-line p-3 sm:grid-cols-2">
        <legend className="sr-only">Risk limits</legend>
        {MONEY_FIELDS.map(({ key, label }) => (
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
        {COUNT_FIELDS.map(({ key, label, min, max }) => (
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
        <div className="flex flex-col gap-2.5 sm:col-span-2">
          {policy.approvalMode !== "autonomous" ? (
            <label className="flex items-center gap-2.5 text-small text-fg">
              <input
                type="checkbox"
                checked={false}
                required
                onChange={() => onChange({ ...policy, approvalMode: "autonomous" })}
                className="size-4 accent-accent"
              />
              Trade on its own within these limits
            </label>
          ) : null}
          <label className="flex items-center gap-2.5 text-small text-fg">
            <input
              type="checkbox"
              checked={policy.allowRiskReducingExits === true}
              onChange={(event) => onChange({ ...policy, allowRiskReducingExits: event.target.checked })}
              className="size-4 accent-accent"
            />
            Allow exits after entry limits are reached
          </label>
          <p className="text-caption text-fg-subtle">100 bps = 1%. Only you can change these limits.</p>
        </div>
      </fieldset>
    </details>
  );
}
