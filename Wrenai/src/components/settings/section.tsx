import type { LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

interface SettingsSectionProps {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly children: ReactNode;
}
export function SettingsSection({
  id,
  title,
  description,
  icon: Icon,
  children,
}: SettingsSectionProps): ReactElement {
  return (
    <section aria-labelledby={id} className="card-shine flex min-w-0 flex-col gap-6 rounded-lg p-card">
      <header className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-sm bg-surface-1 text-accent-text">
          <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={id} className="text-h3 text-fg-strong">
            {title}
          </h2>
          <p className="text-small text-fg-muted">{description}</p>
        </div>
      </header>
      {children}
    </section>
  );
}
