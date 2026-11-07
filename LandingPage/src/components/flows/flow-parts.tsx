"use client";

import {
  type Edge,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
} from "@xyflow/react";
import {
  CandlestickChart,
  Cpu,
  type LucideIcon,
  MessageSquare,
  MousePointerClick,
  Server,
  Shield,
  ShieldCheck,
  Wallet,
  Waypoints,
} from "lucide-react";
import type { ReactElement } from "react";
import type { StepIcon } from "./flow-data";

const ICONS: Readonly<Record<StepIcon, LucideIcon>> = {
  wallet: Wallet,
  server: Server,
  message: MessageSquare,
  cpu: Cpu,
  "shield-check": ShieldCheck,
  pointer: MousePointerClick,
  shield: Shield,
  chart: CandlestickChart,
  waypoints: Waypoints,
};
const STROKE = { strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;

/** Invisible connection points; a hub gets one per spoke, spaced down each side so the lines fan out. */
function Points({
  side,
  type,
  count,
}: {
  readonly side: Position;
  readonly type: "source" | "target";
  readonly count: number;
}): ReactElement {
  // A handle's identity is its slot on that side, so the slot is its stable ID.
  const slots = Array.from({ length: count }, (_, slot) => ({
    id: `${type}-${slot.toString()}`,
    top: `${((slot + 1) / (count + 1)) * 100}%`,
  }));
  return (
    <>
      {slots.map((slot) => (
        <Handle
          key={slot.id}
          id={slot.id}
          type={type}
          position={side}
          isConnectable={false}
          className="flow-handle"
          style={{ top: slot.top }}
        />
      ))}
    </>
  );
}

export interface SpokeData extends Record<string, unknown> {
  readonly label: string;
  readonly icon: StepIcon | null;
  readonly service: boolean;
  readonly side: "input" | "output";
}
export type SpokeNode = Node<SpokeData, "spoke">;

/**
 * A chip on one side of the hub. A service chip holds only its name (`data-service`, where its logo goes later);
 * a Wrenai step adds its icon.
 */
export function SpokeChip({ data }: NodeProps<SpokeNode>): ReactElement {
  const Icon = data.icon ? ICONS[data.icon] : null;
  return (
    <div className="flow-chip" data-step="" data-service={data.service ? data.label : undefined}>
      {Icon ? <Icon size={14} {...STROKE} className="flow-icon" /> : null}
      <span>{data.label}</span>
      <Points
        side={data.side === "input" ? Position.Right : Position.Left}
        type={data.side === "input" ? "source" : "target"}
        count={1}
      />
    </div>
  );
}

export interface HubData extends Record<string, unknown> {
  readonly label: string;
  readonly icon: StepIcon;
  readonly service: boolean;
  readonly inputs: number;
  readonly outputs: number;
}
export type HubNode = Node<HubData, "hub">;

/** The step the flow turns on: a larger tile with an inner face, a ripple ring behind it and its name below. */
export function HubTile({ data }: NodeProps<HubNode>): ReactElement {
  const Icon = ICONS[data.icon];
  return (
    <div className="flow-hub" data-step="">
      <span className="flow-ripple" data-ripple="" />
      <div className="flow-hub-face">
        <Icon size={26} {...STROKE} className="flow-icon" />
      </div>
      <span className="flow-hub-label" data-service={data.service ? data.label : undefined}>
        {data.label}
      </span>
      <Points side={Position.Left} type="target" count={data.inputs} />
      <Points side={Position.Right} type="source" count={data.outputs} />
    </div>
  );
}

export interface LinkData extends Record<string, unknown> {
  readonly striped: boolean;
}
export type LinkEdge = Edge<LinkData, "link">;

/**
 * A right-angled connector with rounded elbows. A plain line carries a beam (a bright head with a dim tail); a
 * striped line warms its dashes as work runs through it. Both overlays use a normalized path length of 100, so
 * the timeline moves them in percent, whatever the line's real length.
 */
export function LinkLine({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<LinkEdge>): ReactElement {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
  });
  if (data?.striped) {
    return (
      <path data-link={id} data-kind="striped" d={path} fill="none" className="flow-link flow-link-striped" />
    );
  }
  return (
    <g>
      <path data-link={id} data-kind="beam" d={path} fill="none" className="flow-link" />
      <path data-trail={id} d={path} pathLength={100} fill="none" className="flow-beam-trail" />
      <path data-beam={id} d={path} pathLength={100} fill="none" className="flow-beam" />
    </g>
  );
}
