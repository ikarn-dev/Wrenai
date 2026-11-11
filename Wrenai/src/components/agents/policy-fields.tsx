"use client";

import { ChevronDown } from "lucide-react";
import { type ComponentPropsWithoutRef, cloneElement, type ReactElement, useId } from "react";
import { agentSetupProfile } from "@/shared/agent-templates";
import { type AgentPolicy, parseUsd, usdInputSchema } from "@/shared/agents";
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

interface PolicyFieldsProps {
  readonly pack: string;
  readonly policy: AgentPolicy;
  readonly onChange: (policy: AgentPolicy) => void;
  readonly disabled: boolean;
}

const UNIT = "pointer-events-none absolute top-1/2 -translate-y-1/2 text-body text-fg-subtle";

function usd(value: string): string | null {
  const parsed = usdInputSchema.safeParse(value);
  return parsed.success ? formatExactMicroUsd(parseUsd(parsed.data)) : null;
}

/** A dollar amount with its "$" inside the control. */
function MoneyInput({
  value,
  onChange,
  ...field
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly id?: string;
  readonly "aria-describedby"?: string;
}): ReactElement {
  return (
    <span className="relative flex">
      <span aria-hidden="true" className={`${UNIT} left-3`}>
        $
      </span>
      <input
        {...field}
        className={`${INPUT_CLASS} pl-7 font-mono tabular-nums`}
        inputMode="decimal"
        autoComplete="off"
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </span>
  );
}

/** A whole number with its unit after it. Percent fields store basis points (1% = 100 bps). */
function NumberInput({
  value,
  onChange,
  unit,
  min,
  max,
  percent = false,
  ...field
}: {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly percent?: boolean;
  readonly id?: string;
  readonly "aria-describedby"?: string;
}): ReactElement {
  const scale = percent ? 100 : 1;
  return (
    <span className="relative flex">
      <input
        {...field}
        type="number"
        step={percent ? 0.01 : 1}
        min={min / scale}
        max={max / scale}
        required
        className={`${INPUT_CLASS} pr-20 font-mono tabular-nums`}
        value={Number.isNaN(value) ? "" : value / scale}
        onChange={(event) => onChange(Math.round(event.target.valueAsNumber * scale))}
      />
      <span aria-hidden="true" className={`${UNIT} right-3`}>
        {unit}
      </span>
    </span>
  );
}

/**
 * The agent's limits as one collapsed row with a plain summary. Opening it shows the three spending limits; the
 * price, fee and pacing settings sit one step further under "More settings", already filled with safe defaults.
 */
export function PolicyFields({ pack, policy, onChange, disabled }: PolicyFieldsProps): ReactElement {
  const profile = agentSetupProfile(pack);
  const payment = pack === "private_payments";
  const perAction = usd(policy.maxTradeUsd);
  const perDay = usd(policy.dailyCapUsd);
  const summary = perAction
    ? `${perAction} per ${profile.action}${perDay ? ` · ${perDay} a day` : ""}`
    : `Set a ${profile.action} limit`;
  const set = (changes: Partial<AgentPolicy>): void => onChange({ ...policy, ...changes });
  return (
    <details className="group rounded-sm border border-line">
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 text-small text-fg">{profile.limits}</span>
        <span className="flex min-w-0 items-center gap-2 text-small text-fg-muted">
          <span className="text-right font-mono tabular-nums">{summary}</span>
          <ChevronDown
            {...ICON}
            className="shrink-0 transition-transform duration-200 ease-ios group-open:rotate-180"
          />
        </span>
      </summary>
      <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-4 border-t border-line p-3">
        <legend className="sr-only">{profile.limits}</legend>
        <p className="text-caption text-fg-subtle">
          The agent never goes over these. Only you can change them.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={`Most per ${profile.action}`}>
            <MoneyInput value={policy.maxTradeUsd} onChange={(value) => set({ maxTradeUsd: value })} />
          </Field>
          <Field label="Most per day">
            <MoneyInput value={policy.dailyCapUsd} onChange={(value) => set({ dailyCapUsd: value })} />
          </Field>
          <Field label="Most in total">
            <MoneyInput value={policy.budgetUsd} onChange={(value) => set({ budgetUsd: value })} />
          </Field>
        </div>
        {policy.approvalMode !== "autonomous" ? (
          <label className="flex items-center gap-2.5 text-small text-fg">
            <input
              type="checkbox"
              checked={false}
              required
              onChange={() => set({ approvalMode: "autonomous" })}
              className="size-4 accent-accent"
            />
            Run this agent automatically within these limits
          </label>
        ) : null}
        <details className="group/more">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-xs text-small text-fg-muted transition-colors duration-200 ease-ios hover:text-fg-strong [&::-webkit-details-marker]:hidden">
            More settings
            <ChevronDown
              {...ICON}
              size={14}
              className="transition-transform duration-200 ease-ios group-open/more:rotate-180"
            />
          </summary>
          <div className="grid gap-4 pt-4 sm:grid-cols-2">
            <Field
              label="Price protection"
              hint={`Skips the ${profile.action} if the price moves more than this.`}
            >
              <NumberInput
                percent
                unit="%"
                min={1}
                max={500}
                value={policy.maxSlippageBps}
                onChange={(value) => set({ maxSlippageBps: value })}
              />
            </Field>
            <Field label="Extra fee limit" hint="0% means no extra provider fee is allowed.">
              <NumberInput
                percent
                unit="%"
                min={0}
                max={2000}
                value={policy.maxProviderFeeBps}
                onChange={(value) => set({ maxProviderFeeBps: value })}
              />
            </Field>
            {payment ? null : (
              <>
                <Field label={`Most ${profile.actions} per hour`}>
                  <NumberInput
                    unit="per hour"
                    min={1}
                    max={60}
                    value={policy.maxTradesPerHour}
                    onChange={(value) => set({ maxTradesPerHour: value })}
                  />
                </Field>
                <Field label={`Wait between ${profile.actions}`}>
                  <NumberInput
                    unit="seconds"
                    min={0}
                    max={86400}
                    value={policy.cooldownSeconds}
                    onChange={(value) => set({ cooldownSeconds: value })}
                  />
                </Field>
              </>
            )}
            {profile.protectiveExits ? (
              <label className="flex items-center gap-2.5 text-small text-fg sm:col-span-2">
                <input
                  type="checkbox"
                  checked={policy.allowRiskReducingExits === true}
                  onChange={(event) => set({ allowRiskReducingExits: event.target.checked })}
                  className="size-4 accent-accent"
                />
                Allow safety sells even after the limits above are reached
              </label>
            ) : null}
          </div>
        </details>
      </fieldset>
    </details>
  );
}
