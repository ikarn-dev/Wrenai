"use client";

import { Handle, type Node, type NodeProps, type Position } from "@xyflow/react";
import Image from "next/image";
import type { ReactElement } from "react";
import { type BrandId, BrandLogo } from "@/components/brands/brand-logo";
import logo from "../../../public/assets/nobg_logo.png";
import { type PrivacyGlyph, PrivacyIcon } from "./privacy-icons";

// The privacy flow's nodes. Each lights with --lit through the timeline (privacy.css); `enter` and `leave` put
// its connection points on the sides the layout needs (left/right in the row, top/bottom in the column).

interface Sides {
  readonly enter: Position | null;
  readonly leave: Position | null;
}

/** Invisible connection points for the layout only. */
function Points({ enter, leave }: Sides): ReactElement {
  return (
    <>
      {enter ? (
        <Handle id="in" type="target" position={enter} isConnectable={false} className="flow-handle" />
      ) : null}
      {leave ? (
        <Handle id="out" type="source" position={leave} isConnectable={false} className="flow-handle" />
      ) : null}
    </>
  );
}

export interface TileData extends Record<string, unknown>, Sides {
  readonly glyph: PrivacyGlyph;
  readonly label: string;
  /** The narrower phone size. */
  readonly compact: boolean;
}
export type TileNode = Node<TileData, "tile">;

/** Something you send: a pill with its icon and name, like the reference's source chips. */
export function SourcePill({ data }: NodeProps<TileNode>): ReactElement {
  return (
    <div data-step="" data-compact={data.compact ? "" : undefined} className="privacy-pill">
      <span className="privacy-icon">
        <PrivacyIcon glyph={data.glyph} />
      </span>
      {data.label}
      <Points enter={data.enter} leave={data.leave} />
    </div>
  );
}

export interface ServiceData extends Record<string, unknown>, Sides {
  readonly brand: BrandId;
  readonly detail: string;
}
export type ServiceNode = Node<ServiceData, "service">;

/** A service on the path: its logo over one word. */
export function ServiceCard({ data }: NodeProps<ServiceNode>): ReactElement {
  return (
    <div data-step="" className="privacy-card">
      <span className="flex min-w-0 flex-col items-start gap-1">
        <span className="privacy-card-name">
          <BrandLogo brand={data.brand} size="chip" />
        </span>
        <span className="privacy-card-detail">{data.detail}</span>
      </span>
      <Points enter={data.enter} leave={data.leave} />
    </div>
  );
}

export type HubNode = Node<Sides & Record<string, unknown>, "hub">;

/** Wrenai, where the Guard checks and the signer signs: the hub tile with the bare mark and a ripple ring. */
export function WrenaiHub({ data }: NodeProps<HubNode>): ReactElement {
  return (
    <div data-step="" className="flow-hub">
      <span className="flow-ripple" data-ripple="" />
      <div className="flow-hub-face">
        <Image src={logo} alt="" height={30} className="logo-mark h-7.5 w-auto" />
      </div>
      <Points enter={data.enter} leave={data.leave} />
    </div>
  );
}

export interface StackData extends Record<string, unknown>, Sides {
  readonly tone: "private" | "public";
  readonly label: string;
  readonly detail: string;
  /** The narrower phone size. */
  readonly compact: boolean;
}
export type StackNode = Node<StackData, "stack">;

/** An outcome, drawn as a stack of results like the reference's verdicts: one card in front, empty ones behind. */
export function OutcomeStack({ data }: NodeProps<StackNode>): ReactElement {
  return (
    <div
      data-step=""
      data-tone={data.tone}
      data-compact={data.compact ? "" : undefined}
      className="privacy-stack"
    >
      <span aria-hidden="true" className="privacy-stack-layer" data-depth="2" />
      <span aria-hidden="true" className="privacy-stack-layer" data-depth="1" />
      <div className="privacy-stack-front">
        <span className="privacy-stack-icon privacy-icon">
          <PrivacyIcon glyph={data.tone} size={20} />
        </span>
        <span className="privacy-card-name">{data.label}</span>
        <span className="privacy-card-detail">{data.detail}</span>
      </div>
      <Points enter={data.enter} leave={data.leave} />
    </div>
  );
}
