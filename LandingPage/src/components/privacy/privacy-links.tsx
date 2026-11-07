"use client";

import { type Edge, type EdgeProps, getSmoothStepPath } from "@xyflow/react";
import type { ReactElement } from "react";

// The privacy flow's lines. Each carries packets whose shape names the operation, riding at the front of a short
// beam: a square for data you send, a diamond for something signed (a verified model reply, a signed order), a
// filled dot for a private transfer, and hollow rings on the striped public leg, which carries no beam. A plain
// line sends two pulses per pass, the striped line three rings, so the lines read as steady traffic.

export type Packet = "data" | "signed" | "private" | "public";

export interface PacketData extends Record<string, unknown> {
  readonly packet: Packet;
  readonly striped: boolean;
}
export type PacketEdge = Edge<PacketData, "packet">;

/** Constant slot IDs: a plain line's two pulses, the striped line's three rings. */
const PULSES = ["first", "second"] as const;
const RINGS = ["first", "second", "third"] as const;
/** Seconds between pulses on one line, and a pulse's trip along it. */
const SPACING = 0.35;
const TRIP = 1.7;
/**
 * A beam is a bright head with a tail that fades behind it: dashes of growing length and falling strength, all
 * with their front at the same point, so together they read as one beam rather than a moving segment. Lengths
 * are in the line's normalized 100 units; widths and strengths are in privacy.css (privacy-beam).
 */
const BEAM = [
  { layer: "far", length: 46 },
  { layer: "spread", length: 24 },
  { layer: "mid", length: 28 },
  { layer: "near", length: 14 },
  { layer: "head", length: 5 },
] as const;

function PacketShape({ packet }: { readonly packet: Packet }): ReactElement {
  switch (packet) {
    case "data":
      return <rect x={-3.5} y={-3.5} width={7} height={7} rx={2} />;
    case "signed":
      return <rect x={-3.5} y={-3.5} width={7} height={7} rx={1} transform="rotate(45)" />;
    case "private":
      return <circle r={4} />;
    case "public":
      return <circle r={3.5} />;
    default: {
      const unknown: never = packet;
      return unknown;
    }
  }
}

/** A right-angled line with rounded elbows, its beams (plain lines only) and its packets, hidden until sent. */
export function PacketLink({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<PacketEdge>): ReactElement {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
  });
  const striped = data?.striped === true;
  const packet = data?.packet ?? "data";
  return (
    <g>
      <path
        data-route={id}
        data-kind={striped ? "striped" : "plain"}
        d={path}
        fill="none"
        className={striped ? "flow-link flow-link-striped" : "flow-link"}
      />
      {striped
        ? null
        : PULSES.map((slot) => (
            <g key={slot} data-beam-of={id} className="privacy-beam">
              {BEAM.map((part) => (
                <path
                  key={part.layer}
                  data-layer={part.layer}
                  data-length={part.length}
                  d={path}
                  pathLength={100}
                  fill="none"
                  strokeDasharray={`${part.length} 200`}
                  strokeDashoffset={part.length}
                />
              ))}
            </g>
          ))}
      {(striped ? RINGS : PULSES).map((slot) => (
        <g key={slot} data-packet-of={id} data-packet={packet} className="privacy-packet">
          <PacketShape packet={packet} />
        </g>
      ))}
    </g>
  );
}

/**
 * Sends one pass along a line from `at`: each packet travels the path (its point read from the path, set as a
 * transform), a beam's head running just behind it on plain lines; the striped line also warms its dashes.
 * Returns when the first packet arrives, so the next step lights on that frame.
 */
export function send(timeline: gsap.core.Timeline, root: HTMLElement, id: string, at: number): number {
  const route = root.querySelector(`[data-route="${id}"]`);
  if (!(route instanceof SVGPathElement)) {
    return at + TRIP;
  }
  const length = route.getTotalLength();
  if (route.getAttribute("data-kind") === "striped") {
    timeline
      .fromTo(route, { "--flow": 0 }, { "--flow": 1, duration: 0.8, ease: "sine.out" }, at)
      .to(route, { "--flow": 0, duration: 1.1, ease: "sine.inOut" }, at + TRIP + SPACING * RINGS.length);
  }
  const beams = Array.from(root.querySelectorAll(`[data-beam-of="${id}"]`));
  const packets = Array.from(root.querySelectorAll(`[data-packet-of="${id}"]`));
  const trip = { duration: TRIP, ease: "power1.inOut" };
  for (const [index, packet] of packets.entries()) {
    const start = at + index * SPACING;
    const point = { t: 0 };
    const place = (): void => {
      const { x, y } = route.getPointAtLength(point.t * length);
      packet.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    };
    timeline
      .fromTo(point, { t: 0 }, { t: 1, ...trip, onUpdate: place, onStart: place }, start)
      .fromTo(packet, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2, immediateRender: false }, start)
      .to(packet, { autoAlpha: 0, duration: 0.2 }, start + TRIP - 0.15);
    const beam = beams[index];
    if (beam) {
      timeline
        .fromTo(beam, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.15, immediateRender: false }, start)
        .to(beam, { autoAlpha: 0, duration: 0.25 }, start + TRIP - 0.2);
      // Every layer's front stays on the packet: offset length − 100t puts a dash's front at t of the line.
      for (const part of Array.from(beam.querySelectorAll("[data-length]"))) {
        const dash = Number(part.getAttribute("data-length"));
        timeline.fromTo(
          part,
          { strokeDashoffset: dash },
          { strokeDashoffset: dash - 100, ...trip, immediateRender: false },
          start,
        );
      }
    }
  }
  return at + TRIP;
}
