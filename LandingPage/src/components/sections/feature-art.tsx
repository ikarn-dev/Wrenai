import type { ReactElement, ReactNode } from "react";

// Line drawings for the feature cells, in the manner of a technical drawing: one solid form carries the idea,
// dotted construction lines show its structure, and small squares mark the ends. Each is a metaphor, not a
// picture of an object. Drawn in currentColor at 1 px (non-scaling), so they follow the cell's text color and
// stay crisp at any size. Decoration only: the cell's title and text say what the drawing suggests.

const SOLID = {
  stroke: "currentColor",
  strokeWidth: 1,
  vectorEffect: "non-scaling-stroke",
  fill: "none",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;
const DOTTED = { ...SOLID, strokeDasharray: "1 3" } as const;

function Art({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 160 112" className="feature-art h-28 w-40">
      {children}
    </svg>
  );
}

/** A small filled square marking the end of a construction line. */
function Mark({ x, y }: { readonly x: number; readonly y: number }): ReactElement {
  return <rect x={x - 1.5} y={y - 1.5} width="3" height="3" fill="currentColor" />;
}

/** Isometric rhombus centered on (cx, cy): half-width w, half-height h. */
function rhombus(cx: number, cy: number, w: number, h: number): string {
  return `M${cx} ${cy - h}L${cx + w} ${cy}L${cx} ${cy + h}L${cx - w} ${cy}Z`;
}

/**
 * Jarvis, a chat: two message bubbles with tails, Jarvis's on the upper left as an outline and yours on the
 * lower right filled with the hatch, the way a chat marks your own messages.
 */
export function ConversationArt(): ReactElement {
  return (
    <Art>
      <Hatch id="chat-hatch" />
      <path
        d="M16 24H98A8 8 0 0 1 106 32V40A8 8 0 0 1 98 48H16C12 48 9 49 4 49C7 47 8 44 8 40V32A8 8 0 0 1 16 24Z"
        {...SOLID}
      />
      <path
        d="M62 63H144A8 8 0 0 1 152 71V79C152 83 153 86 156 88C151 88 148 87 144 87H62A8 8 0 0 1 54 79V71A8 8 0 0 1 62 63Z"
        {...SOLID}
        fill="url(#chat-hatch)"
      />
    </Art>
  );
}

/** The frame's diagonal hatch (the strip dividers' pattern) as an SVG fill, faint, in the drawing's color. */
function Hatch({ id }: { readonly id: string }): ReactElement {
  return (
    <defs>
      <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
        <path d="M0 0V4" stroke="currentColor" strokeWidth="1" strokeOpacity="0.4" />
      </pattern>
    </defs>
  );
}

/**
 * Strategies, a knight: the chess piece that moves by plan. A geometric head with an ear, a hollow eye and a
 * diagonal cut through the neck, standing on a base bar. Outlined and filled with the hatch, like the shield.
 */
export function KnightArt(): ReactElement {
  return (
    <Art>
      <Hatch id="knight-hatch" />
      <path
        d="M46 4H80A35 35 0 0 1 114 39V68L100 83H57L96 33H91L68 62H53V11ZM58.5 29a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0Z"
        fillRule="evenodd"
        {...SOLID}
        fill="url(#knight-hatch)"
      />
      <rect x="53" y="89" width="61" height="19" {...SOLID} fill="url(#knight-hatch)" />
    </Art>
  );
}

/**
 * Guard, a geometric shield: a squared U-band closing to a point, with a block resting in its opening. Both
 * are outlined and filled with the hatch, not solid.
 */
export function ShieldArt(): ReactElement {
  return (
    <Art>
      <Hatch id="guard-hatch" />
      <path d="M33 27H56V69L80 82L104 69V27H127V81L80 108L33 81Z" {...SOLID} fill="url(#guard-hatch)" />
      <rect x="56" y="4" width="48" height="23" {...SOLID} fill="url(#guard-hatch)" />
    </Art>
  );
}

/** Private inference, isolation: stacked planes, the middle one solid, one axis through all. Sealed, yet checkable. */
export function LayersArt(): ReactElement {
  return (
    <Art>
      <path d="M80 4V108M40 30V82M120 30V82" {...DOTTED} />
      <path d={rhombus(80, 30, 40, 20)} {...DOTTED} />
      <path d={rhombus(80, 82, 40, 20)} {...DOTTED} />
      <path d={rhombus(80, 56, 40, 20)} {...SOLID} />
      <circle cx="80" cy="56" r="2" fill="currentColor" />
      <Mark x={80} y={4} />
      <Mark x={80} y={108} />
    </Art>
  );
}

// The five agents at the corners of a pentagon (radius 44 around the drawing's center).
const AGENT_NODES = [
  { id: "top", x: 80, y: 12 },
  { id: "right", x: 122, y: 42 },
  { id: "lower-right", x: 106, y: 92 },
  { id: "lower-left", x: 54, y: 92 },
  { id: "left", x: 38, y: 42 },
] as const;
const NODE = 16;

/**
 * Agents, a network: five agents at the corners of a pentagon, tied to their neighbours by solid sides and to
 * every other agent by a dashed inner star (the frame's 4 px dash, like the section lines). The agents are
 * hollow squares; the lines are masked out under them, so no line runs through a node.
 */
export function AgentsArt(): ReactElement {
  return (
    <Art>
      <mask id="agents-links">
        <rect width="160" height="112" fill="#fff" />
        {AGENT_NODES.map((node) => (
          <rect
            key={node.id}
            x={node.x - NODE / 2}
            y={node.y - NODE / 2}
            width={NODE}
            height={NODE}
            rx="4"
            fill="#000"
          />
        ))}
      </mask>
      <g mask="url(#agents-links)">
        <path d="M80 12L122 42L106 92H54L38 42Z" {...SOLID} />
        <path
          d="M80 12L106 92L38 42H122L54 92Z"
          {...SOLID}
          strokeDasharray="4 4"
          strokeLinecap="butt"
          strokeOpacity="0.6"
        />
      </g>
      {AGENT_NODES.map((node) => (
        <rect
          key={node.id}
          x={node.x - NODE / 2}
          y={node.y - NODE / 2}
          width={NODE}
          height={NODE}
          rx="4"
          {...SOLID}
        />
      ))}
    </Art>
  );
}
