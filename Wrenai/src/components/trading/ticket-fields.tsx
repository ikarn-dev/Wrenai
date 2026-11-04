"use client";
import { type ReactElement, useId } from "react";

// Controls shared by the Spot trade dialog and the Perps ticket, so both read and behave the same.

export const SLIPPAGE = [
  { value: 25, label: "0.25%" },
  { value: 50, label: "0.5%" },
  { value: 100, label: "1%" },
] as const;

interface SegmentOption<T> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
}

/** A labelled row of equal buttons for one choice; the chosen one is raised on the sunken track. */
export function Segment<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}): ReactElement {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 text-caption text-fg-subtle">{label}</legend>
      <div className="grid auto-cols-fr grid-flow-col gap-1 rounded-sm bg-sunken p-1 ring-1 ring-line-card ring-inset">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            disabled={option.disabled}
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
            className={`h-8 min-w-0 cursor-pointer rounded-xs px-1 text-caption font-medium whitespace-nowrap transition-colors duration-200 ease-ios disabled:cursor-not-allowed disabled:text-fg-disabled pointer-coarse:h-11 ${option.value === value ? "bg-surface-3 text-fg-strong" : "text-fg-muted hover:text-fg-strong"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** A decimal input with its unit inside the field ("0.00  USDC"). */
export function UnitField({
  label,
  unit,
  value,
  onChange,
  placeholder = "0.00",
  required = false,
}: {
  readonly label: string;
  readonly unit: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly required?: boolean;
}): ReactElement {
  const id = useId();
  return (
    <label htmlFor={id} className="flex min-w-0 flex-col gap-1.5 text-caption text-fg-subtle">
      {label}
      <span className="flex items-center rounded-sm bg-sunken ring-1 ring-line-strong ring-inset focus-within:ring-2 focus-within:ring-accent">
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          autoComplete="off"
          placeholder={placeholder}
          required={required}
          className="min-h-11 w-full min-w-0 bg-transparent px-3 font-mono text-body tabular-nums text-fg-strong outline-none placeholder:text-fg-subtle"
        />
        <span className="shrink-0 pr-3 text-caption font-medium text-fg-muted">{unit}</span>
      </span>
    </label>
  );
}
