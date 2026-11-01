import { CircleAlert, Info, type LucideIcon, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/** info: the user stopped it. warn: clears by waiting or retrying. error: needs something else. */
export type NoticeTone = "info" | "warn" | "error";

export interface Notice {
  readonly tone: NoticeTone;
  readonly text: string;
}

const TONES: Readonly<
  Record<NoticeTone, { readonly icon: LucideIcon; readonly text: string; readonly box: string }>
> = {
  info: { icon: Info, text: "text-fg-muted", box: "bg-surface-2" },
  warn: { icon: TriangleAlert, text: "text-warn", box: "bg-warn-soft" },
  error: { icon: CircleAlert, text: "text-loss", box: "bg-loss-soft" },
};

export function NoticeLine({ notice }: { readonly notice: Notice }) {
  const { icon: Icon, text } = TONES[notice.tone];
  return (
    <span className={`inline-flex items-center gap-1.5 ${text}`}>
      <Icon aria-hidden="true" size={16} strokeWidth={1.75} absoluteStrokeWidth className="shrink-0" />
      {notice.text}
    </span>
  );
}

/** A notice on its tone's soft fill, for page-level states such as data that couldn't be checked. */
export function NoticeBox({ notice }: { readonly notice: Notice }) {
  return (
    <p role="status" className={`rounded-md px-4 py-3 text-body ${TONES[notice.tone].box}`}>
      <NoticeLine notice={notice} />
    </p>
  );
}

const CELL = "col-start-1 row-start-1 flex items-center justify-center gap-1.5";

/**
 * One line under an action: the note, replaced in place by a notice when the action stops. Both share one grid
 * cell, so the line's height never changes and nothing around it moves.
 */
export function StatusLine({ note, notice }: { readonly note: ReactNode; readonly notice: Notice | null }) {
  return (
    <div className="grid text-body">
      <p className={`${CELL} text-fg-muted ${notice === null ? "" : "invisible"}`}>{note}</p>
      <p aria-live="polite" className={CELL}>
        {notice === null ? null : <NoticeLine notice={notice} />}
      </p>
    </div>
  );
}
