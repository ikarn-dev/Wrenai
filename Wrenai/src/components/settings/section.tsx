import type { ReactElement, ReactNode } from "react";

interface SettingsPanelProps {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}

/** One settings tab: its title over a single card of rows split by dividers. */
export function SettingsPanel({ id, title, children }: SettingsPanelProps): ReactElement {
  return (
    <section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-4">
      <h2 id={`${id}-title`} className="text-h2 font-medium text-fg-strong">
        {title}
      </h2>
      <div className="flex flex-col divide-y divide-line-card card-shine rounded-lg px-card">{children}</div>
    </section>
  );
}

interface SettingsRowProps {
  readonly label: string;
  readonly description?: string;
  /** Wide content (forms, multi-step flows) goes under the label instead of beside it. */
  readonly stacked?: boolean;
  readonly children: ReactNode;
}

/** A label and an optional short line on the left, the value or control on the right (stacked on narrow cards). */
export function SettingsRow({
  label,
  description,
  stacked = false,
  children,
}: SettingsRowProps): ReactElement {
  return (
    <div
      className={`flex min-w-0 flex-col gap-4 py-4 ${stacked ? "" : "sm:flex-row sm:items-center sm:justify-between sm:gap-8"}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-body font-medium text-fg-strong">{label}</p>
        {description === undefined ? null : <p className="text-small text-fg-muted">{description}</p>}
      </div>
      <div className={`min-w-0 ${stacked ? "" : "sm:shrink-0"}`}>{children}</div>
    </div>
  );
}

/** A tab's rows while its data streams in, in the card's final shape. */
export function SettingsRowsSkeleton({ rows }: { readonly rows: readonly string[] }): ReactElement {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col divide-y divide-line-card">
      {rows.map((row) => (
        <div key={row} aria-hidden="true" className="flex items-center justify-between gap-8 py-4">
          <div className="flex flex-col gap-2">
            <span className="block h-4 w-28 rounded-xs bg-surface-2 motion-safe:animate-pulse" />
            <span className="block h-3.5 w-44 rounded-xs bg-surface-2 motion-safe:animate-pulse" />
          </div>
          <span className="block h-9 w-28 rounded-sm bg-surface-2 motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}
