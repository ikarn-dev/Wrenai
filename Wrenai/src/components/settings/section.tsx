import type { ReactElement, ReactNode } from "react";

interface SettingsPanelProps {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}

/** One settings tab: its title and one line of context, then a single card of rows split by dividers. */
export function SettingsPanel({ title, description, children }: SettingsPanelProps): ReactElement {
  return (
    <section aria-labelledby="settings-panel-title" className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h2 id="settings-panel-title" className="text-h2 font-medium text-fg-strong">
          {title}
        </h2>
        <p className="text-small text-fg-muted">{description}</p>
      </header>
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

/** A label and its one-line explanation on the left, the value or control on the right (stacked on narrow cards). */
export function SettingsRow({
  label,
  description,
  stacked = false,
  children,
}: SettingsRowProps): ReactElement {
  return (
    <div
      className={`flex min-w-0 flex-col gap-4 py-5 ${stacked ? "" : "sm:flex-row sm:items-center sm:justify-between sm:gap-8"}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-body font-medium text-fg-strong">{label}</p>
        {description === undefined ? null : <p className="text-small text-fg-muted">{description}</p>}
      </div>
      <div className={`min-w-0 ${stacked ? "" : "sm:shrink-0"}`}>{children}</div>
    </div>
  );
}
