import type { ReactElement, ReactNode } from "react";
import type { AgentPack } from "./agent-data";

// One line icon per agent, drawn for Wrenai on a 24 px grid: 1.75 px round strokes like the rest of the site's
// icons, no fills except a single point where it marks the subject. Each draws what the agent does.
const GLYPHS: Readonly<Record<AgentPack, ReactNode>> = {
  // A payment leaving: a folded plane on its way out.
  private_payments: (
    <>
      <path d="M20.5 3.5 10.75 13.25" />
      <path d="m20.5 3.5-6 17-3.75-7.25L3.5 9.5z" />
    </>
  ),
  // The same purchase at equal intervals: three even slices, each with its buy.
  dca: (
    <>
      <path d="M3.5 20.5h17" />
      <path d="M6.5 16.5v-5" />
      <path d="M12 16.5v-5" />
      <path d="M17.5 16.5v-5" />
      <circle cx="6.5" cy="7" r="1.5" />
      <circle cx="12" cy="7" r="1.5" />
      <circle cx="17.5" cy="7" r="1.5" />
    </>
  ),
  // Buy or sell: one pair, either way.
  spot_trader: (
    <>
      <path d="M4 8h14.5" />
      <path d="m15 4.5 3.5 3.5-3.5 3.5" />
      <path d="M20 16H5.5" />
      <path d="M9 12.5 5.5 16 9 19.5" />
    </>
  ),
  // Two candles: a leveraged market's long and short.
  perps: (
    <>
      <path d="M8 3.5v17" />
      <rect x="5.5" y="7.5" width="5" height="8" rx="1.25" />
      <path d="M16 5.5v13" />
      <rect x="13.5" y="9.5" width="5" height="5" rx="1.25" />
    </>
  ),
  // A scan: two rings, the sweep, and one new find.
  meme_hunter: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.25" />
      <path d="M12 12 18 6" />
      <circle cx="15.75" cy="15" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  // The price falls to a level, and the buy sits at the low.
  buy_the_dip: (
    <>
      <path d="M3.5 5.5 9 11.5l3-2.75 2.75 5.5" />
      <path d="M3.5 20.5h17" strokeDasharray="1.5 3" />
      <circle cx="16" cy="16.75" r="2" />
    </>
  ),
  // The price climbs to a target, and the sale sits at the high.
  sell_the_top: (
    <>
      <path d="M3.5 18.5 9 12.5l3 2.75 2.75-5.5" />
      <path d="M3.5 3.5h17" strokeDasharray="1.5 3" />
      <circle cx="16" cy="7.25" r="2" />
    </>
  ),
};

/** An agent's icon, inheriting the text color. Decorative: the agent's name always sits beside it. */
export function AgentIcon({
  pack,
  size = 20,
}: {
  readonly pack: AgentPack;
  readonly size?: number;
}): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {GLYPHS[pack]}
    </svg>
  );
}
