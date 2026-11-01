import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "light" | "accent" | "warn" | "loss";

// Docs/DESIGN.md → Components → Badges. A tinted fill with its own text color, plus a faint inset ring in the same
// tone, so the badge holds its edge on any surface. Pairs measured: accent-text on accent-soft 11.61:1, warn on
// warn-soft 8.17:1, loss on loss-soft 6.40:1, fg on surface-3 9.54:1; light in globals.css (badge-light).
const TONES: Readonly<Record<BadgeTone, string>> = {
  neutral: "bg-surface-3 text-fg ring-1 ring-line-strong/50 ring-inset",
  light: "badge-light",
  accent: "bg-accent-soft text-accent-text ring-1 ring-accent-line ring-inset",
  warn: "bg-warn-soft text-warn ring-1 ring-warn/30 ring-inset",
  loss: "bg-loss-soft text-loss ring-1 ring-loss/30 ring-inset",
};

const SHAPE = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full text-small font-medium";

/**
 * Badge styles for a control that should read as a badge, such as Sign out or the agent key link. Sized for a
 * 32 px (44 px touch) target.
 */
export function badgeClasses(tone: BadgeTone): string {
  return `${SHAPE} ${TONES[tone]} h-8 px-3 pointer-coarse:h-11`;
}

interface BadgeProps {
  readonly tone: BadgeTone;
  /** A status dot before the label. The label always carries the meaning; the dot only repeats it. */
  readonly dot?: boolean;
  readonly children: ReactNode;
}

export function Badge({ tone, dot = false, children }: BadgeProps) {
  return (
    <span className={`${SHAPE} ${TONES[tone]} badge-shine h-6 px-2.5`}>
      {dot ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
