"use client";

import { type FitViewOptions, ReactFlow, useNodesInitialized } from "@xyflow/react";
import { type ReactElement, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { gsap, ScrollTrigger, useGSAP } from "@/components/motion/gsap";
import { type Flow, spokeAnchor } from "./flow-data";
import { FlowFit } from "./flow-fit";
import { type HubNode, HubTile, type LinkEdge, LinkLine, SpokeChip, type SpokeNode } from "./flow-parts";
import { useBoxReady } from "./use-box-ready";

const NODE_TYPES = { hub: HubTile, spoke: SpokeChip };
const EDGE_TYPES = { link: LinkLine };
const HUB = "hub";
// The pace of one pass: inputs light one after another, their lines carry work into the hub, the hub ripples,
// then its lines carry the result out. Unhurried, with a long rest before it repeats.
const TRAVEL = 1.7;
const STAGGER = 0.35;
const RISE = 0.6;
const HOLD = 1.4;
const REST = 2.2;

/** A chip or the hub warms to mint, holds, and cools. */
export function light(timeline: gsap.core.Timeline, target: Element | null, at: number): void {
  if (target) {
    timeline
      .fromTo(target, { "--lit": 0 }, { "--lit": 1, duration: RISE, ease: "power2.out" }, at)
      .to(target, { "--lit": 0, duration: 1.2, ease: "power2.inOut" }, at + HOLD);
  }
}

/**
 * A plain line fires a beam: a bright head and a dim tail sweep the path together (stroke dash offsets in the
 * path's normalized 0–100 length). A striped line instead warms its dashes for the length of the work.
 */
function carry(timeline: gsap.core.Timeline, root: HTMLElement, id: string, at: number): void {
  const line = root.querySelector(`[data-link="${id}"]`);
  if (line?.getAttribute("data-kind") === "striped") {
    timeline
      .fromTo(line, { "--flow": 0 }, { "--flow": 1, duration: 0.8, ease: "sine.out" }, at)
      .to(line, { "--flow": 0, duration: 1.1, ease: "sine.inOut" }, at + TRAVEL);
    return;
  }
  const beam = root.querySelector(`[data-beam="${id}"]`);
  const trail = root.querySelector(`[data-trail="${id}"]`);
  if (!beam || !trail) {
    return;
  }
  const sweep = { duration: TRAVEL, ease: "power2.inOut" };
  timeline
    .fromTo([beam, trail], { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 }, at)
    .fromTo(beam, { strokeDashoffset: 10 }, { strokeDashoffset: -110, ...sweep }, at)
    .fromTo(trail, { strokeDashoffset: 36 }, { strokeDashoffset: -84, ...sweep }, at)
    .to([beam, trail], { autoAlpha: 0, duration: 0.35 }, at + TRAVEL - 0.3);
}

/** The hub answers with one ring that widens and fades: transform and opacity only. */
export function ripple(timeline: gsap.core.Timeline, target: Element | null, at: number): void {
  if (target) {
    timeline.fromTo(
      target,
      { scale: 1, autoAlpha: 0.65 },
      { scale: 1.55, autoAlpha: 0, duration: 1.8, ease: "power2.out" },
      at,
    );
  }
}

/**
 * One looping GSAP timeline per card, started once React Flow has drawn its connectors and run only while the
 * card is on screen. Transform, opacity and one CSS variable; reduced motion keeps the still diagram.
 */
function FlowTimeline({
  flow,
  root,
}: {
  readonly flow: Flow;
  readonly root: RefObject<HTMLDivElement | null>;
}): null {
  const initialized = useNodesInitialized();
  const [ready, setReady] = useState(false);
  // Connectors are drawn a frame after the nodes are measured; wait for that frame before reading their paths.
  useEffect(() => {
    if (!initialized) {
      return;
    }
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, [initialized]);

  useGSAP(
    () => {
      const element = root.current;
      if (!ready || !element) {
        return;
      }
      const step = (id: string): Element | null =>
        element.querySelector(`.react-flow__node[data-id="${id}"] [data-step]`);
      const media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        const timeline = gsap.timeline({ repeat: -1, repeatDelay: REST, paused: true });
        for (const [index, input] of flow.inputs.entries()) {
          const at = index * STAGGER;
          light(timeline, step(input.id), at);
          carry(timeline, element, `${input.id}-${HUB}`, at + 0.4);
        }
        const hubAt = (flow.inputs.length - 1) * STAGGER + 0.4 + TRAVEL;
        light(timeline, step(HUB), hubAt);
        ripple(timeline, element.querySelector("[data-ripple]"), hubAt);
        for (const [index, output] of flow.outputs.entries()) {
          const at = hubAt + 0.6 + index * STAGGER;
          carry(timeline, element, `${HUB}-${output.id}`, at);
          light(timeline, step(output.id), at + TRAVEL - 0.2);
        }
        const trigger = ScrollTrigger.create({
          trigger: element,
          start: "top bottom",
          end: "bottom top",
          onToggle: (self) => {
            element.toggleAttribute("data-paused", !self.isActive);
            if (self.isActive) {
              timeline.play();
            } else {
              timeline.pause();
            }
          },
        });
        if (trigger.isActive) {
          timeline.play();
        }
      });
      return () => media.revert();
    },
    { dependencies: [ready, flow], revertOnUpdate: true },
  );
  return null;
}

function flowNodes(flow: Flow): (HubNode | SpokeNode)[] {
  const spokes = (side: "input" | "output"): SpokeNode[] =>
    (side === "input" ? flow.inputs : flow.outputs).map((spoke, index) => ({
      id: spoke.id,
      type: "spoke",
      position: spokeAnchor(flow, side, index),
      // Chips differ in width: inputs hang from their right edge and outputs from their left, so every line has
      // the same reach to the hub.
      origin: side === "input" ? [1, 0.5] : [0, 0.5],
      data: { label: spoke.label, icon: spoke.icon ?? null, brand: spoke.brand ?? null, side },
    }));
  return [
    {
      id: HUB,
      type: "hub",
      position: { x: 0, y: 0 },
      origin: [0.5, 0.5],
      data: {
        label: flow.hub.label,
        icon: flow.hub.icon,
        brand: flow.hub.brand ?? null,
        inputs: flow.inputs.length,
        outputs: flow.outputs.length,
      },
    },
    ...spokes("input"),
    ...spokes("output"),
  ];
}
function flowEdges(flow: Flow): LinkEdge[] {
  return [
    ...flow.inputs.map((input, index) => ({
      id: `${input.id}-${HUB}`,
      source: input.id,
      sourceHandle: "source-0",
      target: HUB,
      targetHandle: `target-${index.toString()}`,
      type: "link" as const,
      data: { striped: input.striped === true },
    })),
    ...flow.outputs.map((output, index) => ({
      id: `${HUB}-${output.id}`,
      source: HUB,
      sourceHandle: `source-${index.toString()}`,
      target: output.id,
      targetHandle: "target-0",
      type: "link" as const,
      data: { striped: output.striped === true },
    })),
  ];
}

// Room for the names under the tiles. One constant, so the refit on resize uses the same box as the first fit.
const FIT: FitViewOptions = { padding: { top: 0.12, bottom: 0.24, left: 0.08, right: 0.08 }, maxZoom: 1.1 };

/** A static React Flow canvas: no panning, zooming or selection, and page scrolling passes straight through. */
export function FlowDiagram({ flow }: { readonly flow: Flow }): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const ready = useBoxReady(root);
  const nodes = useMemo(() => flowNodes(flow), [flow]);
  const edges = useMemo(() => flowEdges(flow), [flow]);
  return (
    <div ref={root} className="flow-canvas size-full">
      {ready ? <FlowCanvas flow={flow} root={root} nodes={nodes} edges={edges} /> : null}
    </div>
  );
}

/** The canvas itself, mounted only into a sized box (useBoxReady). */
function FlowCanvas({
  flow,
  root,
  nodes,
  edges,
}: {
  readonly flow: Flow;
  readonly root: RefObject<HTMLDivElement | null>;
  readonly nodes: (HubNode | SpokeNode)[];
  readonly edges: LinkEdge[];
}): ReactElement {
  return (
    <ReactFlow
      defaultNodes={nodes}
      defaultEdges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      colorMode="dark"
      fitView
      fitViewOptions={FIT}
      minZoom={0.3}
      maxZoom={1.1}
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
      <FlowTimeline flow={flow} root={root} />
      <FlowFit box={root} options={FIT} />
    </ReactFlow>
  );
}
