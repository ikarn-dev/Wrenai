import type { ReactElement } from "react";
import { FlowArt } from "@/components/flows/flow-art";
import { FLOWS, type Flow } from "@/components/flows/flow-data";
import { FramedSection } from "./section-frame";

/** One flow per cell: the live diagram above, its title and one line under it, like the feature cells. */
function FlowCell({ flow }: { readonly flow: Flow }): ReactElement {
  return (
    <article className="feature-cell group flex flex-col gap-6 p-frame">
      <FlowArt flow={flow} />
      <div className="flex flex-col gap-1.5">
        <h3 className="text-hero-lead font-medium">{flow.title}</h3>
        <p className="feature-text max-w-md text-body">{flow.text}</p>
      </div>
    </article>
  );
}

// Two full-width rows of the frame, each split three fifths and two fifths, the wide cell alternating sides.
const ROWS: readonly (readonly Flow[])[] = [FLOWS.slice(0, 2), FLOWS.slice(2, 4)];

/** How Wrenai runs: a title, then the flows as hub-and-spoke diagrams in the frame's hairline grid. */
export function Workflows(): ReactElement {
  return (
    <>
      <FramedSection id="workflows" labelledBy="workflows-title" tight>
        {/* The Features and Agents header pattern: the title over three fifths, the explanation on the right edge
            over two, both on one baseline; the same split as the cells below. */}
        <header className="grid gap-4 lg:grid-cols-5 lg:items-center lg:gap-10">
          <h2 id="workflows-title" data-reveal="rise" className="text-section lg:col-span-3">
            How it <span className="text-accent-text">runs</span>
          </h2>
          <p
            data-reveal="fade"
            data-reveal-delay="0.2"
            className="section-lede max-w-sm text-fg-muted lg:col-span-2 lg:justify-self-end"
          >
            Live flows from the app. Striped lines run in the background.
          </p>
        </header>
      </FramedSection>
      {ROWS.map((row) => (
        <div key={row[0]?.id} className="relative sm:px-gutter">
          <div aria-hidden="true" className="frame-rule absolute inset-x-0 top-0 z-10" />
          <div
            data-reveal="stagger"
            className="mx-auto grid w-full max-w-landing gap-px border-x border-line-card bg-line-card lg:grid-cols-5"
          >
            {row.map((flow) => (
              <div key={flow.id} className={`grid ${flow.wide ? "lg:col-span-3" : "lg:col-span-2"}`}>
                <FlowCell flow={flow} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
