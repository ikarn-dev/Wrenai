"use client";

import {
  type Edge,
  type EdgeProps,
  getStraightPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import type { LucideIcon } from "lucide-react";
import { type ReactElement, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { FlowDrawn } from "@/components/flows/flow-drawn";

// An agent's steps as a small React Flow pipeline, like the "How it runs" diagrams: tiles joined by lines that
// carry a beam from one step to the next. Tiles keep their real pixel size (zoom 1, laid out from the measured
// width) so text never scales. Always one row; below about 410 px the tiles turn compact, at the same height.

export interface Phase {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly icon: LucideIcon;
}

const STROKE = { strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;
/** Tile height (px), the same in both sizes, so the card never changes height when the layout is picked. */
const TILE = 64;
/** Space between tiles (px), where the beams run: roomy, then tight on narrow cards. */
const GAP = 24;
const TIGHT_GAP = 10;
/** The narrowest tile (px) that fits an icon and the longest name ("Bought") on one line. */
const MIN_TILE = 84;

interface PhaseData extends Record<string, unknown> {
  readonly label: string;
  readonly detail: string;
  readonly icon: LucideIcon;
  readonly compact: boolean;
  readonly enter: Position | null;
  readonly leave: Position | null;
}
type PhaseNode = Node<PhaseData, "phase">;
type BeamEdge = Edge<Record<string, unknown>, "beam">;

/**
 * One step, lit with --lit (agent-lifecycle.css). Full size: icon and name on a line, the detail below. Compact
 * (phones): the icon over the name, centered, without the detail, so four tiles still share one row.
 */
function PhaseTile({ data }: NodeProps<PhaseNode>): ReactElement {
  return (
    <div data-phase="" data-compact={data.compact ? "" : undefined} className="agent-phase">
      {data.compact ? (
        <>
          <data.icon size={16} {...STROKE} />
          <span className="truncate text-small">{data.label}</span>
        </>
      ) : (
        <>
          <span className="flex min-w-0 items-center gap-1.5">
            <data.icon size={16} {...STROKE} />
            <span className="truncate text-body">{data.label}</span>
          </span>
          <span className="agent-step-detail truncate text-small">{data.detail}</span>
        </>
      )}
      {data.enter ? (
        <Handle id="in" type="target" position={data.enter} isConnectable={false} className="flow-handle" />
      ) : null}
      {data.leave ? (
        <Handle id="out" type="source" position={data.leave} isConnectable={false} className="flow-handle" />
      ) : null}
    </div>
  );
}

/** A straight line between two tiles with a beam on its normalized length of 100. */
function BeamLink({ id, sourceX, sourceY, targetX, targetY }: EdgeProps<BeamEdge>): ReactElement {
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  return (
    <g>
      <path d={path} fill="none" className="flow-link" />
      <path data-beam={id} d={path} pathLength={100} fill="none" className="agent-beam" />
    </g>
  );
}

const NODE_TYPES = { phase: PhaseTile };
const EDGE_TYPES = { beam: BeamLink };

interface Layout {
  /** Changes when the tiles move, so the canvas and its timeline are rebuilt. */
  readonly key: string;
  readonly compact: boolean;
  readonly tile: number;
  readonly gap: number;
}
/** Always one row, as on desktop; a card too narrow for full tiles gets compact ones with tighter gaps. */
function phaseLayout(width: number): Layout {
  const roomy = Math.floor((width - GAP * 3) / 4);
  if (roomy >= MIN_TILE) {
    return { key: `row-${roomy.toString()}`, compact: false, tile: roomy, gap: GAP };
  }
  const tight = Math.floor((width - TIGHT_GAP * 3) / 4);
  return { key: `compact-${tight.toString()}`, compact: true, tile: tight, gap: TIGHT_GAP };
}

/** The row runs left to right. */
function phaseNodes(steps: readonly Phase[], layout: Layout): PhaseNode[] {
  return steps.map((phase, index) => ({
    id: phase.id,
    type: "phase",
    position: { x: index * (layout.tile + layout.gap), y: 0 },
    style: { width: layout.tile, height: TILE },
    data: {
      label: phase.label,
      detail: phase.detail,
      icon: phase.icon,
      compact: layout.compact,
      enter: index === 0 ? null : Position.Left,
      leave: index === steps.length - 1 ? null : Position.Right,
    },
  }));
}
function phaseEdges(steps: readonly Phase[]): BeamEdge[] {
  return steps.slice(1).map((phase, index) => ({
    id: `beam-${index.toString()}`,
    source: steps[index]?.id ?? phase.id,
    sourceHandle: "out",
    target: phase.id,
    targetHandle: "in",
    type: "beam" as const,
  }));
}

/** Measures the box's width and picks the layout; it changes only when a tile would move. */
function usePhaseLayout(box: RefObject<HTMLDivElement | null>): Layout | null {
  const [layout, setLayout] = useState<Layout | null>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      // Lay out (and so mount the canvas) only once the box has both a width and a height: React Flow reports
      // error 004 if it mounts into a box that isn't laid out yet.
      const rect = entries[0]?.contentRect;
      const width = rect?.width;
      if (width === undefined || width <= 0 || !rect || rect.height <= 0) {
        return;
      }
      const next = phaseLayout(width);
      setLayout((current) => (current?.key === next.key ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [box]);
  return layout;
}

/**
 * The steps as a static pipeline: no panning, zooming or selection, and page scrolling passes through.
 * `onDrawn` receives the layout's key once its lines exist, so the scene's timeline can find the beams.
 */
export function PhaseFlow({
  steps,
  onDrawn,
}: {
  readonly steps: readonly Phase[];
  readonly onDrawn: (id: string) => void;
}): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const layout = usePhaseLayout(box);
  const nodes = useMemo(() => (layout ? phaseNodes(steps, layout) : []), [steps, layout]);
  const edges = useMemo(() => phaseEdges(steps), [steps]);
  return (
    <div ref={box} className="flow-canvas h-16 w-full">
      {layout ? (
        <ReactFlow
          key={layout.key}
          defaultNodes={nodes}
          defaultEdges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          colorMode="dark"
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          minZoom={1}
          maxZoom={1}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
        >
          <FlowDrawn id={layout.key} onDrawn={onDrawn} />
        </ReactFlow>
      ) : null}
    </div>
  );
}

/**
 * Plays the pipeline from `at`: each tile lights `gap` seconds after the one before, and a beam leaves it at once
 * and reaches the next tile on the frame that tile lights.
 */
export function runPhases(timeline: gsap.core.Timeline, root: HTMLElement, at: number, gap: number): void {
  const tiles = Array.from(root.querySelectorAll("[data-phase]"));
  for (const [index, tile] of tiles.entries()) {
    const start = at + index * gap;
    timeline.to(tile, { "--lit": 1, duration: 0.3, ease: "power2.out" }, start);
    const beam = root.querySelector(`[data-beam="beam-${index.toString()}"]`);
    if (beam) {
      // The head is 40 of the line's 100 units: from just before the start until its front meets the next tile.
      timeline
        .fromTo(
          beam,
          { strokeDashoffset: 40, autoAlpha: 1 },
          { strokeDashoffset: -60, duration: gap, ease: "power1.inOut", immediateRender: false },
          start,
        )
        .to(beam, { autoAlpha: 0, duration: 0.2 }, start + gap);
    }
  }
}
