import type { ReactElement, ReactNode } from "react";

// The content column inside the frame. From sm the side rails sit inside the page gutter; on phones they run
// along the screen edges, so the content keeps its width. Strips and sections share it, so the rails line up.
const OUTER = "sm:px-gutter";
const COLUMN = "mx-auto w-full max-w-landing border-x border-line-card";

/**
 * The frame every section below Powered by lives in. Horizontal lines run the full page width, edge to edge:
 * solid across the column and dashed beyond it (frame-rule); the vertical rails stay on the column. The frame
 * ends with a closing line.
 */
export function SectionFrame({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div>
      {children}
      <div aria-hidden="true" className="frame-rule" />
    </div>
  );
}

/** The separator between framed sections: frame lines above and below a striped strip in the column. */
export function StripDivider(): ReactElement {
  return (
    <div aria-hidden="true">
      <div className="frame-rule" />
      <div className={OUTER}>
        <div className={`${COLUMN} strip-pattern h-strip`} />
      </div>
      <div className="frame-rule" />
    </div>
  );
}

interface FramedSectionProps {
  readonly id?: string;
  readonly labelledBy: string;
  /** A shorter top (40 → 56 px) for a section whose content starts right under its title. */
  readonly tight?: boolean;
  readonly children: ReactNode;
}

/** A section inside the frame: the dot grid fading down from its top, then its content at the frame padding. */
export function FramedSection({ id, labelledBy, tight = false, children }: FramedSectionProps): ReactElement {
  return (
    <section id={id} aria-labelledby={labelledBy} className={`scroll-mt-6 ${OUTER}`}>
      <div
        className={`${COLUMN} relative isolate px-frame ${tight ? "pt-section-tight pb-section" : "py-section"}`}
      >
        <div
          aria-hidden="true"
          className="dot-grid pointer-events-none absolute inset-x-0 top-0 -z-10 h-96"
        />
        {children}
      </div>
    </section>
  );
}
