import type { CSSProperties, ReactElement } from "react";
import type { LivePhase } from "./live-model";

// A voxel-style pixel character: a blocky body with arms and four legs, drawn as square pixels with a stepped
// extrusion behind them, so it reads as a small 3D box. Its pose and one pixel prop follow the agent's live phase.
// Colours are tokens only: mint faces while it works, neutral greys when it has stopped. Motion lives in
// app/styles/live.css (transform and opacity, stepped for a pixel feel); parts that move carry no SVG transform.

const U = 6; // one pixel, in viewBox units
const DEPTH = 3; // extrusion steps, one viewBox unit each
const ORIGIN = { x: 30, y: 22 };

// B body, E eye, A arm, L/R the two alternating leg pairs.
const SPRITE = [
  "..BBBBBBBB..",
  "..BBBBBBBB..",
  "..BEBBBBEB..",
  "AABBBBBBBBAA",
  "..BBBBBBBB..",
  "..BBBBBBBB..",
  "..L.R..L.R..",
  "..L.R..L.R..",
] as const;

interface Run {
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

/** Consecutive cells of the given kinds merged into one rect per row, so the sprite stays a few dozen nodes. */
function runs(kinds: string): readonly Run[] {
  const out: Run[] = [];
  SPRITE.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x += 1) {
      const filled = x < row.length && kinds.includes(row.charAt(x));
      if (filled && start < 0) {
        start = x;
      } else if (!filled && start >= 0) {
        out.push({ x: start, y, w: x - start });
        start = -1;
      }
    }
  });
  return out;
}

/** Top edges: cells whose upper neighbour is empty catch the light. */
function topEdges(kinds: string): readonly Run[] {
  return runs(kinds).flatMap((run) => {
    const above = SPRITE[run.y - 1] ?? "";
    const cells: Run[] = [];
    for (let x = run.x; x < run.x + run.w; x += 1) {
      if (!kinds.includes(above.charAt(x))) {
        const last = cells.at(-1);
        if (last && last.x + last.w === x) {
          cells[cells.length - 1] = { ...last, w: last.w + 1 };
        } else {
          cells.push({ x, y: run.y, w: 1 });
        }
      }
    }
    return cells;
  });
}

interface Palette {
  readonly front: string;
  readonly side: string;
  readonly top: string;
}
// Colour says the status at a glance: mint while it works, brighter mint when done, amber when it needs review,
// grey when stopped. The same meanings as the status badges (Docs/DESIGN.md → Status).
const MINT: Palette = { front: "fill-accent", side: "fill-accent-line", top: "fill-accent-text" };
const DONE: Palette = { front: "fill-accent-text", side: "fill-accent", top: "fill-fg-strong" };
const WARN: Palette = { front: "fill-warn", side: "fill-warn-soft", top: "fill-fg-strong" };
const IDLE: Palette = { front: "fill-surface-5", side: "fill-surface-4", top: "fill-fg-subtle" };

function paletteFor(phase: LivePhase): Palette {
  switch (phase) {
    case "stopped":
      return IDLE;
    case "blocked":
      return WARN;
    case "completed":
      return DONE;
    default:
      return MINT;
  }
}

/** One part of the sprite as a solid extruded block: depth layers, front face, lit top edges. */
function Voxels({ kinds, palette }: { readonly kinds: string; readonly palette: Palette }): ReactElement {
  const cells = runs(kinds);
  const rect = (run: Run, dx: number, dy: number, height = U) => (
    <rect
      key={`${run.x}:${run.y}:${dx}:${height}`}
      x={ORIGIN.x + run.x * U + dx}
      y={ORIGIN.y + run.y * U + dy}
      width={run.w * U}
      height={height}
    />
  );
  return (
    <g>
      <g className={palette.side}>
        {Array.from({ length: DEPTH }, (_unused, step) => DEPTH - step).flatMap((step) =>
          cells.map((run) => rect(run, step, -step)),
        )}
      </g>
      <g className={palette.front}>{cells.map((run) => rect(run, 0, 0))}</g>
      <g className={palette.top}>{topEdges(kinds).map((run) => rect(run, 0, 0, 1.5))}</g>
    </g>
  );
}

function at(x: number, y: number): { readonly x: number; readonly y: number } {
  return { x: ORIGIN.x + x * U, y: ORIGIN.y + y * U };
}

function delay(seconds: number): CSSProperties {
  return { animationDelay: `${seconds}s` };
}

/** Square pixel at sprite coordinates, sized in sprite pixels. */
function Pixel({
  x,
  y,
  size = 1,
  className,
  style,
}: {
  readonly x: number;
  readonly y: number;
  readonly size?: number;
  readonly className: string;
  readonly style?: CSSProperties;
}): ReactElement {
  const p = at(x, y);
  return <rect x={p.x} y={p.y} width={size * U} height={size * U} className={className} style={style} />;
}

function Eyes({ phase }: { readonly phase: LivePhase }): ReactElement {
  const closed = phase === "stopped";
  const motion =
    phase === "watching" ? "px-scan" : phase === "quoting" || phase === "starting" ? "px-glance" : "px-blink";
  return (
    <g className={closed ? "" : motion}>
      {[3, 8].map((x) => {
        const p = at(x, 2);
        return (
          <rect
            key={x}
            x={p.x}
            y={closed ? p.y + U - 2 : p.y}
            width={U}
            height={closed ? 2 : U}
            className="fill-accent-fg"
          />
        );
      })}
    </g>
  );
}

/** The phase's pixel prop beside or above the character. `progress` drives the wait meter. */
function Prop({
  phase,
  progress,
}: {
  readonly phase: LivePhase;
  readonly progress: number;
}): ReactElement | null {
  switch (phase) {
    case "waiting": {
      // Eight cells fill with the real countdown to the next order.
      const filled = Math.floor(progress * 8);
      return (
        <g>
          {Array.from({ length: 8 }, (_unused, index) => index).map((index) => (
            <rect
              key={`meter-${index}`}
              x={ORIGIN.x + 14 * U}
              y={ORIGIN.y + (7 - index) * U + 1}
              width={U - 2}
              height={U - 2}
              className={index < filled ? "fill-accent" : "fill-surface-3"}
            />
          ))}
        </g>
      );
    }
    case "watching":
      return (
        <g>
          {[3, 5, 2, 6, 4].map((height, index) => (
            <rect
              key={`bar-${height}`}
              x={ORIGIN.x + (13.5 + index * 0.8) * U}
              y={ORIGIN.y + (8 - height) * U}
              width={U * 0.6}
              height={height * U}
              className="px-dot fill-accent-line"
              style={delay(index * 0.25)}
            />
          ))}
        </g>
      );
    case "starting":
    case "quoting":
      return (
        <g>
          {[0, 1.5, 3].map((offset, index) => (
            <Pixel
              key={offset}
              x={4 + offset}
              y={-2.2}
              className="px-dot fill-accent-text"
              style={delay(index * 0.3)}
            />
          ))}
        </g>
      );
    case "submitting":
      return <Pixel x={12.4} y={3} className="px-send fill-accent-text" />;
    case "settling":
      return (
        <g>
          {[13, 14.5, 16].map((x, index) => (
            <Pixel
              key={x}
              x={x}
              y={6.5}
              size={0.5}
              className="px-dot fill-accent-line"
              style={delay(index * 0.3)}
            />
          ))}
          <Pixel x={17.5} y={5.5} size={1.5} className="px-dot fill-accent" />
        </g>
      );
    case "blocked":
      return (
        <g>
          <Pixel x={5.5} y={-3.6} className="fill-warn" />
          <Pixel x={5.5} y={-2.6} className="fill-warn" />
          <Pixel x={5.5} y={-1.2} size={0.9} className="fill-warn" />
        </g>
      );
    case "stopped":
      return (
        <g>
          <Pixel x={11} y={-1} size={0.7} className="px-zz fill-fg-subtle" />
          <Pixel x={12.5} y={-2.4} size={0.5} className="px-zz fill-fg-subtle" style={delay(1.3)} />
        </g>
      );
    case "completed":
      return (
        <g>
          {[
            [0.5, -2],
            [11, -2.5],
            [13, 1],
            [-1.5, 1.5],
          ].map(([x = 0, y = 0], index) => (
            <Pixel
              key={`${x}:${y}`}
              x={x}
              y={y}
              size={0.6}
              className="px-sparkle fill-accent-text"
              style={delay(index * 0.35)}
            />
          ))}
        </g>
      );
    default: {
      const unhandled: never = phase;
      throw new Error(`Unhandled phase ${String(unhandled)}`);
    }
  }
}

const BODY_MOTION: Readonly<Record<LivePhase, string>> = {
  starting: "",
  waiting: "px-bob",
  watching: "px-bob",
  quoting: "px-bob",
  submitting: "px-squash",
  settling: "px-bob",
  blocked: "",
  stopped: "px-sink",
  completed: "",
};

/**
 * The agent's pixel character, posed for its live phase and in step with the rest of the live view: it bobs beside
 * a meter that fills with the real countdown while waiting, scans with its eyes over price bars while watching,
 * thinks while quoting, squashes and throws a block while submitting, walks while an order settles, freezes under
 * an amber "!" when blocked, goes grey and dozes when stopped, and hops with sparkles when done. Decorative.
 */
export function PixelAgent({
  phase,
  progress,
  className = "h-16 w-auto",
}: {
  readonly phase: LivePhase;
  /** How far the wait for the next order has run, 0 to 1. */
  readonly progress: number;
  readonly className?: string;
}): ReactElement {
  const palette = paletteFor(phase);
  const walking = phase === "settling" || phase === "starting";
  const floor = ORIGIN.y + SPRITE.length * U;
  return (
    <svg aria-hidden="true" viewBox="0 0 150 74" className={className} shapeRendering="crispEdges">
      <rect x={ORIGIN.x + 1.5 * U} y={floor + 1} width={9 * U} height={2} className="fill-surface-3" />
      {/* The whole character hops when starting or done; otherwise the body moves over planted legs. */}
      <g className={phase === "starting" || phase === "completed" ? "px-hop" : ""}>
        <g className={BODY_MOTION[phase]}>
          <g className={phase === "completed" ? "px-cheer" : ""}>
            <Voxels kinds="A" palette={palette} />
          </g>
          <Voxels kinds="BE" palette={palette} />
          <Eyes phase={phase} />
        </g>
        <g className={walking ? "px-step" : "group-data-moving:px-step"}>
          <Voxels kinds="L" palette={palette} />
        </g>
        <g className={walking ? "px-step" : "group-data-moving:px-step"} style={delay(0.25)}>
          <Voxels kinds="R" palette={palette} />
        </g>
      </g>
      <Prop phase={phase} progress={progress} />
    </svg>
  );
}
