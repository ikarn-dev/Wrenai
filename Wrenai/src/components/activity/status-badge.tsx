import { Ban, CircleCheck, CircleX, Clock3, FileCheck2, type LucideIcon, Undo2 } from "lucide-react";
import type { ReactElement } from "react";
import type { ActivityEntry } from "@/shared/activity";

export type BadgeTone = "success" | "warn" | "loss" | "neutral";

// Text and icon share the tone on its soft fill, with a faint ring of the same tone so the badge keeps its edge
// on a hovered row (surface-2). Measured: accent-text on accent-soft 11.61:1, warn on warn-soft 8.17:1, loss on
// loss-soft 6.40:1, fg-muted on surface-3 7.23:1.
export const BADGE_TONES: Readonly<Record<BadgeTone, string>> = {
  success: "bg-accent-soft text-accent-text ring-accent-line/40",
  warn: "bg-warn-soft text-warn ring-warn/30",
  loss: "bg-loss-soft text-loss ring-loss/30",
  neutral: "bg-surface-3 text-fg-muted ring-line-strong/40",
};

const STATUS: Readonly<
  Record<
    ActivityEntry["status"],
    { readonly label: string; readonly tone: BadgeTone; readonly icon: LucideIcon }
  >
> = {
  completed: { label: "Success", tone: "success", icon: CircleCheck },
  pending: { label: "Pending", tone: "warn", icon: Clock3 },
  failed: { label: "Failed", tone: "loss", icon: CircleX },
  recorded: { label: "Recorded", tone: "neutral", icon: FileCheck2 },
  cancelled: { label: "Cancelled", tone: "neutral", icon: Ban },
  refunded: { label: "Refunded", tone: "neutral", icon: Undo2 },
};

/**
 * An activity status as a compact tinted badge: icon and word in the tone's color, never color alone. Squarer
 * than attribute pills (radius-xs, 6 px) so it reads as a state in a table cell; one line, Inter 500 at small.
 */
export function ActivityStatusBadge({ status }: { readonly status: ActivityEntry["status"] }): ReactElement {
  const { label, tone, icon: Icon } = STATUS[status];
  return (
    <span
      className={`inline-flex h-6 min-w-26 items-center justify-center gap-1.5 rounded-xs px-2 text-small font-medium whitespace-nowrap ring-1 ring-inset ${BADGE_TONES[tone]}`}
    >
      <Icon aria-hidden="true" size={14} strokeWidth={1.75} absoluteStrokeWidth className="shrink-0" />
      {label}
    </span>
  );
}
