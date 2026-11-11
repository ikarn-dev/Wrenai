"use client";

import { Eye, EyeOff } from "lucide-react";
import { type ReactElement, useId, useState } from "react";

export const FIELD =
  "h-10 w-full rounded-sm border border-line-strong bg-sunken px-3 text-small text-fg-strong transition-colors duration-200 ease-ios placeholder:text-fg-subtle hover:border-fg-subtle disabled:text-fg-disabled pointer-coarse:h-11";

interface PasswordFieldProps {
  readonly name: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly disabled: boolean;
}

/** An uncontrolled password input with a show/hide toggle. Only the toggle holds state, so typing never re-renders. */
export function PasswordField({ name, label, placeholder, disabled }: PasswordFieldProps): ReactElement {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-small text-fg-muted">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          spellCheck={false}
          required
          minLength={12}
          maxLength={1024}
          disabled={disabled}
          {...(placeholder ? { placeholder } : {})}
          className={`${FIELD} pr-10`}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          disabled={disabled}
          className="absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center rounded-r-sm text-fg-subtle transition-colors duration-200 ease-ios hover:text-fg-strong disabled:cursor-default disabled:text-fg-disabled"
        >
          <Icon aria-hidden="true" size={16} strokeWidth={1.75} absoluteStrokeWidth />
        </button>
      </div>
    </div>
  );
}
