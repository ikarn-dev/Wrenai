import { Info, Lightbulb, type LucideIcon, ShieldAlert, TriangleAlert } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

type Tone = "info" | "tip" | "warning" | "danger";

// Soft fills from the app's notices: neutral for notes, mint for tips, the status colors for cautions. Text stays fg
// on every fill; only the icon and the edge carry the tone (DESIGN.md → Meaning never relies on color alone).
const TONES: Readonly<
  Record<Tone, { readonly icon: LucideIcon; readonly box: string; readonly mark: string }>
> = {
  info: { icon: Info, box: "bg-surface-2 ring-line-card", mark: "text-fg-muted" },
  tip: { icon: Lightbulb, box: "bg-accent-soft ring-accent-line/40", mark: "text-accent-text" },
  warning: { icon: TriangleAlert, box: "bg-warn-soft ring-warn/25", mark: "text-warn" },
  danger: { icon: ShieldAlert, box: "bg-loss-soft ring-loss/25", mark: "text-loss" },
};

const LABELS: Readonly<Record<Tone, string>> = {
  info: "Note",
  tip: "Tip",
  warning: "Warning",
  danger: "Important",
};

/** A note set apart from the text: `<Callout tone="warning">…</Callout>`. */
export function Callout({
  tone = "info",
  children,
}: {
  readonly tone?: Tone;
  readonly children: ReactNode;
}): ReactElement {
  const style = TONES[tone];
  const Icon = style.icon;
  return (
    <aside className={`flex gap-3 rounded-md px-4 py-3.5 ring-1 ring-inset ${style.box}`}>
      <Icon
        aria-hidden="true"
        size={16}
        strokeWidth={1.75}
        absoluteStrokeWidth
        className={`mt-1 shrink-0 ${style.mark}`}
      />
      <div className="min-w-0 text-small leading-relaxed text-fg [&>*+*]:mt-2 [&_a]:text-accent-text">
        <span className="sr-only">{LABELS[tone]}: </span>
        {children}
      </div>
    </aside>
  );
}
