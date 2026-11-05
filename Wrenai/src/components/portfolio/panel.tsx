import type { LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

const ICON = { "aria-hidden": true, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

interface PortfolioPanelProps {
  readonly id: string;
  readonly title: string;
  /**
   * Docs/DESIGN.md → Typography → Roles → Card title: a mono uppercase eyebrow for data cards, or Inter 600 `h3`
   * in sentence case for a card that names its subject.
   */
  readonly heading?: "eyebrow" | "title";
  readonly aside?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}

const HEADING = {
  eyebrow: "font-mono text-eyebrow uppercase text-fg-muted",
  title: "min-w-0 truncate text-h3 text-fg-strong",
} as const;

/** A neutral card with its title row; every Portfolio card shares its padding and header height. */
export function PortfolioPanel({
  id,
  title,
  heading = "eyebrow",
  aside,
  className = "",
  children,
}: PortfolioPanelProps): ReactElement {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className={`@container flex min-w-0 flex-col gap-4 card-shine rounded-lg p-card ${className}`}
    >
      <header className="flex min-h-6 items-center justify-between gap-3">
        <h3 id={`${id}-heading`} className={HEADING[heading]}>
          {title}
        </h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

interface PortfolioSectionProps {
  readonly id: string;
  readonly title: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}

/** A titled group of cards: a quiet heading row, then the cards. */
export function PortfolioSection({ id, title, aside, children }: PortfolioSectionProps): ReactElement {
  return (
    <section aria-labelledby={`${id}-heading`} className="flex min-w-0 flex-col gap-4">
      <header className="flex min-h-9 items-center justify-between gap-3">
        <h2 id={`${id}-heading`} className="text-h2 font-medium">
          {title}
        </h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

interface StatTileProps {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly children: ReactNode;
  readonly meta?: ReactNode;
}

/**
 * One fact as its own card, laid out like a dashboard metric card: mono eyebrow top-left with the icon on the
 * right, the value below, and a caption pinned to the bottom so a row of cards lines up.
 */
export function StatTile({ icon: Icon, label, children, meta }: StatTileProps): ReactElement {
  return (
    // The label row sits at the top and the value with its caption at the bottom, so a card stretched to its row
    // keeps the figure on the row's bottom edge instead of leaving an empty band under it.
    <dl className="flex min-w-0 flex-col justify-between gap-3 card-shine rounded-lg p-4">
      <div className="flex items-center justify-between gap-3">
        <dt className="font-mono text-eyebrow uppercase text-fg-muted">{label}</dt>
        <Icon {...ICON} size={16} className="shrink-0 text-accent-text" />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <dd className="min-w-0 truncate text-lead text-fg-strong">{children}</dd>
        {meta === undefined ? null : <dd className="text-caption text-fg-subtle">{meta}</dd>}
      </div>
    </dl>
  );
}
