"use client";

import dynamic from "next/dynamic";
import type { ReactElement } from "react";
import type { Flow } from "./flow-data";

// React Flow is the page's heaviest client code, so it loads only with this section (CODE_PRACTICES → React).
const FlowDiagram = dynamic(() => import("./flow-diagram").then((module) => module.FlowDiagram), {
  ssr: false,
  loading: () => null,
});

/** The diagram area of a workflow card. Its height is fixed, so the card never shifts when the diagram loads. */
export function FlowArt({ flow }: { readonly flow: Flow }): ReactElement {
  return (
    <div aria-hidden="true" className="flow-art relative h-64 w-full sm:h-72">
      <div className="dot-grid flow-art-grid pointer-events-none absolute inset-0" />
      <div className="absolute inset-0">
        <FlowDiagram flow={flow} />
      </div>
    </div>
  );
}
