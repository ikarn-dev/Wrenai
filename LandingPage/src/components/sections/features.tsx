import type { ReactElement, ReactNode } from "react";
import { AgentsArt, ConversationArt, KnightArt, LayersArt, ShieldArt } from "./feature-art";
import { FramedSection } from "./section-frame";

interface Feature {
  /** An in-page anchor for the nav (Guard, Jarvis; Privacy has its own section). */
  readonly id?: string;
  readonly title: string;
  readonly text: string;
  readonly art: ReactNode;
}

// Claims stay inside what the product shows today (Docs/wrenai-spec.md §10).
const ROWS: readonly (readonly Feature[])[] = [
  [
    {
      id: "jarvis",
      title: "Ask Jarvis about NEAR",
      text: "Prices, yields, perps and new tokens, researched with live data. Each answer gives a clear lean.",
      art: <ConversationArt />,
    },
    {
      title: "Strategies in plain words",
      text: "Describe the plan. It becomes rules you review, and the agent starts paused.",
      art: <KnightArt />,
    },
    {
      id: "guard",
      title: "A Guard the model can't override",
      text: "Every trade is checked against your limits first. If a check can't run, the trade doesn't.",
      art: <ShieldArt />,
    },
  ],
  [
    {
      title: "Private inference",
      text: "Models run in secure enclaves on NEAR AI Cloud, and each reply's signature is checked.",
      art: <LayersArt />,
    },
    {
      title: "A team of agents",
      text: "Each agent runs one strategy with its own budget. One switch stops them all.",
      art: <AgentsArt />,
    },
  ],
];

/** A flat cell: the line drawing centered in its upper part, the title and one line of text at the bottom. */
function FeatureCell({ feature }: { readonly feature: Feature }): ReactElement {
  return (
    <article id={feature.id} className="feature-cell group flex min-h-80 scroll-mt-6 flex-col gap-10 p-frame">
      <div className="flex flex-1 items-center justify-center">{feature.art}</div>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-hero-lead font-medium">{feature.title}</h3>
        <p className="feature-text max-w-sm text-body">{feature.text}</p>
      </div>
    </article>
  );
}

// Each row is its own band, so its top line runs the full page width like the frame's other lines. Inside,
// a 1 px gap over the line color draws the dividers between cells. Three cells on the first row, two on the
// second, on a six-column grid so both rows fill the width.
const SPAN: Readonly<Record<number, string>> = { 3: "lg:col-span-2", 2: "lg:col-span-3" };

/**
 * What Wrenai does: a split header (title left, explanation right), then the features as flat cells in two
 * full-width rows of the frame.
 */
export function Features(): ReactElement {
  return (
    <>
      <FramedSection id="how-it-works" labelledBy="features-title">
        {/* Split header from lg: the title over three fifths, so each of its two lines fits without wrapping,
            and the explanation over the last two, on the right edge. Both sit on one bottom line. */}
        <header className="grid gap-4 lg:grid-cols-5 lg:items-end lg:gap-10">
          <h2
            id="features-title"
            data-reveal="rise"
            className="text-section lg:col-span-3 lg:whitespace-nowrap"
          >
            <span className="block">Research first.</span>
            <span className="block">
              Then hand it to an <span className="text-accent-text">agent</span>
            </span>
          </h2>
          <p
            data-reveal="fade"
            data-reveal-delay="0.2"
            className="max-w-md text-hero-lead text-fg-muted lg:col-span-2 lg:justify-self-end"
          >
            Jarvis looks into NEAR markets with you. An agent then follows the plan, inside limits only you
            can change.
          </p>
        </header>
      </FramedSection>
      {ROWS.map((row) => (
        <div key={row[0]?.title} className="relative sm:px-gutter">
          <div aria-hidden="true" className="frame-rule absolute inset-x-0 top-0 z-10" />
          <div
            data-reveal="stagger"
            className="mx-auto grid w-full max-w-landing gap-px border-x border-line-card bg-line-card lg:grid-cols-6"
          >
            {row.map((feature) => (
              <div key={feature.title} className={`grid ${SPAN[row.length] ?? ""}`}>
                <FeatureCell feature={feature} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
