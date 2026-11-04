import type { ReactElement, ReactNode } from "react";

/**
 * The column every section below Powered by lives in: hairline rails on both sides and a closing line at the
 * bottom. From sm the rails sit inside the page gutter; on phones they run along the screen edges, so the
 * content keeps its width.
 */
export function SectionFrame({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className="sm:px-gutter">
      <div className="mx-auto w-full max-w-landing border-x border-b border-line-card">{children}</div>
    </div>
  );
}

/** The separator between framed sections: a striped strip between two hairlines, spanning the rails. */
export function StripDivider(): ReactElement {
  return <div aria-hidden="true" className="strip-pattern h-strip border-y border-line-card" />;
}

interface FramedSectionProps {
  readonly id?: string;
  readonly labelledBy: string;
  readonly children: ReactNode;
}

/** A section inside the frame: the dot grid fading down from its top, then its content at the frame padding. */
export function FramedSection({ id, labelledBy, children }: FramedSectionProps): ReactElement {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className="relative isolate scroll-mt-6 px-frame py-section"
    >
      <div aria-hidden="true" className="dot-grid pointer-events-none absolute inset-x-0 top-0 -z-10 h-96" />
      {children}
    </section>
  );
}
