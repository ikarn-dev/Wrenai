"use client";

import dynamic from "next/dynamic";
import type { ReactElement } from "react";

// React Flow loads only with this section (CODE_PRACTICES → React: heavy client libraries at the point of use).
const PrivacyFlow = dynamic(() => import("./privacy-flow").then((module) => module.PrivacyFlow), {
  ssr: false,
  loading: () => null,
});

/**
 * The privacy diagram, on the section's own dot grid. Decorative: the section describes the same path in words.
 * The box reserves each layout's height (column 35 rem, row 18 rem from lg), so nothing shifts when it loads.
 */
export function PrivacyArt(): ReactElement {
  return (
    <div aria-hidden="true" className="h-140 w-full lg:h-72">
      <PrivacyFlow />
    </div>
  );
}
