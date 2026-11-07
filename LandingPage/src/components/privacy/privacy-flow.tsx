"use client";

import { type FitViewOptions, Position, ReactFlow } from "@xyflow/react";
import { type ReactElement, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSceneLoop } from "@/components/agents/agent-loop";
import { light, ripple } from "@/components/flows/flow-diagram";
import { FlowDrawn } from "@/components/flows/flow-drawn";
import { FlowFit } from "@/components/flows/flow-fit";
import type { PrivacyGlyph } from "./privacy-icons";
import { type Packet, type PacketEdge, PacketLink, send } from "./privacy-links";
import {
  type HubNode,
  OutcomeStack,
  ServiceCard,
  type ServiceNode,
  SourcePill,
  type StackNode,
  type TileNode,
  WrenaiHub,
} from "./privacy-nodes";

// What stays private, as one flow (Docs/wrenai-prd.md → Safety, privacy and cost; cloud-architecture.md §5):
// your chat, strategy and account context go to NEAR AI Cloud, whose TEE runs the model and signs each reply;
// Wrenai checks the Guard and signs; NEAR Intents' confidential route keeps swaps and payments off the public
// chain, while wallet deposits and payouts to public wallets stay public. Beams carry the private path; the
// striped line is the public leg. Wrenai's own backend is not drawn as private, because it isn't.

const NODE_TYPES = { tile: SourcePill, service: ServiceCard, hub: WrenaiHub, stack: OutcomeStack };
const EDGE_TYPES = { packet: PacketLink };

type PrivacyNode = TileNode | ServiceNode | HubNode | StackNode;
type Placement = Readonly<{ x: number; y: number }>;

const SOURCES: readonly { readonly id: string; readonly glyph: PrivacyGlyph; readonly label: string }[] = [
  { id: "chat", glyph: "chat", label: "Chat" },
  { id: "strategy", glyph: "strategy", label: "Strategy" },
  { id: "account", glyph: "account", label: "Account" },
];

/**
 * Node anchors (px at zoom 1). The row reads left to right; the column, for narrow screens, top to bottom. In the
 * row the source pills (one shared width) hang from their right edges at x 0, 52 px apart (36 px pills, 16 px
 * between), so all three start their lines at one edge; everything else is centered.
 */
const PLACES: Readonly<Record<"row" | "column", Readonly<Record<string, Placement>>>> = {
  row: {
    chat: { x: 0, y: -52 },
    strategy: { x: 0, y: 0 },
    account: { x: 0, y: 52 },
    ai: { x: 210, y: 0 },
    wrenai: { x: 430, y: 0 },
    intents: { x: 650, y: 0 },
    private: { x: 890, y: -62 },
    public: { x: 890, y: 62 },
  },
  // Phones: compact pills (96 px) and stacks (148 px), 8 px apart, so each row is 304 px and the whole column
  // fits a 360 px screen at about full size; every node is centered on one axis.
  column: {
    chat: { x: -104, y: 0 },
    strategy: { x: 0, y: 0 },
    account: { x: 104, y: 0 },
    ai: { x: 0, y: 104 },
    wrenai: { x: 0, y: 228 },
    intents: { x: 0, y: 352 },
    private: { x: -78, y: 468 },
    public: { x: 78, y: 468 },
  },
};

function privacyNodes(layout: "row" | "column"): PrivacyNode[] {
  const row = layout === "row";
  const enter = row ? Position.Left : Position.Top;
  const leave = row ? Position.Right : Position.Bottom;
  const at = (id: string): Placement => PLACES[layout][id] ?? { x: 0, y: 0 };
  const center: [number, number] = [0.5, 0.5];
  return [
    ...SOURCES.map(
      (source): TileNode => ({
        id: source.id,
        type: "tile",
        position: at(source.id),
        origin: row ? [1, 0.5] : center,
        data: { glyph: source.glyph, label: source.label, compact: !row, enter: null, leave },
      }),
    ),
    {
      id: "ai",
      type: "service",
      position: at("ai"),
      origin: center,
      data: { brand: "near-ai", detail: "TEE, verified", enter, leave },
    },
    { id: "wrenai", type: "hub", position: at("wrenai"), origin: center, data: { enter, leave } },
    {
      id: "intents",
      type: "service",
      position: at("intents"),
      origin: center,
      data: { brand: "near-intents", detail: "Confidential", enter, leave },
    },
    {
      id: "private",
      type: "stack",
      position: at("private"),
      origin: center,
      data: {
        tone: "private",
        label: "Private",
        detail: "Swaps, payments",
        compact: !row,
        enter,
        leave: null,
      },
    },
    {
      id: "public",
      type: "stack",
      position: at("public"),
      origin: center,
      data: {
        tone: "public",
        label: "Public",
        detail: "Deposits, payouts",
        compact: !row,
        enter,
        leave: null,
      },
    },
  ];
}

function link(source: string, target: string, packet: Packet): PacketEdge {
  return {
    id: `${source}-${target}`,
    source,
    sourceHandle: "out",
    target,
    targetHandle: "in",
    type: "packet",
    data: { packet, striped: packet === "public" },
  };
}
// What each line carries: your data into the enclave, a signed reply out of it, a signed order to NEAR Intents,
// then a private transfer or the public leg.
const EDGES: readonly PacketEdge[] = [
  ...SOURCES.map((source) => link(source.id, "ai", "data")),
  link("ai", "wrenai", "signed"),
  link("wrenai", "intents", "signed"),
  link("intents", "private", "private"),
  link("intents", "public", "public"),
];

/**
 * A row from the lg breakpoint, a column below it so the text never shrinks to fit. It follows the same media
 * query as the height PrivacyArt reserves, so the canvas fills its box without a shift.
 */
const WIDE = "(width >= 64rem)";
function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
function currentLayout(): "row" | "column" {
  return window.matchMedia(WIDE).matches ? "row" : "column";
}

/**
 * Plays one pass: your inputs light and send their data to NEAR AI Cloud; a signed reply goes to Wrenai (a
 * ripple), a signed order to NEAR Intents, which sends the private transfer while the public leg runs its rings.
 * Each step lights on the frame its first packet arrives.
 */
function playPrivacy(timeline: gsap.core.Timeline, element: HTMLElement): void {
  const step = (id: string): Element | null =>
    element.querySelector(`.react-flow__node[data-id="${id}"] [data-step]`);
  let ai = 0;
  for (const [index, source] of SOURCES.entries()) {
    const at = index * 0.35;
    light(timeline, step(source.id), at);
    ai = Math.max(ai, send(timeline, element, `${source.id}-ai`, at + 0.3));
  }
  light(timeline, step("ai"), ai);
  const hub = send(timeline, element, "ai-wrenai", ai + 0.4);
  light(timeline, step("wrenai"), hub);
  ripple(timeline, element.querySelector("[data-ripple]"), hub);
  const intents = send(timeline, element, "wrenai-intents", hub + 0.5);
  light(timeline, step("intents"), intents);
  light(timeline, step("private"), send(timeline, element, "intents-private", intents + 0.4));
  light(timeline, step("public"), send(timeline, element, "intents-public", intents + 0.4));
}

// A thin margin (2% a side), so the 304 px phone column fits a 360 px screen at about 93% instead of 85%.
const FIT: FitViewOptions = { padding: 0.02, maxZoom: 1 };

/** The static canvas: no panning, zooming or selection, and page scrolling passes straight through. */
export function PrivacyFlow(): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const layout = useSyncExternalStore<"row" | "column" | null>(subscribe, currentLayout, () => null);
  const [drawn, setDrawn] = useState<string | null>(null);
  const nodes = useMemo(() => (layout ? privacyNodes(layout) : []), [layout]);
  useSceneLoop(box, playPrivacy, 2.2, drawn);
  return (
    <div ref={box} className="flow-canvas size-full">
      {layout ? (
        <ReactFlow
          key={layout}
          defaultNodes={nodes}
          defaultEdges={[...EDGES]}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          colorMode="dark"
          fitView
          fitViewOptions={FIT}
          minZoom={0.5}
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
          <FlowDrawn id={layout} onDrawn={setDrawn} />
          <FlowFit box={box} options={FIT} />
        </ReactFlow>
      ) : null}
    </div>
  );
}
