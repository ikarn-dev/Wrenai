"use client";

import { ArrowUpRight, ChevronLeft, ChevronRight } from "lucide-react";
import Image from "next/image";
import { type KeyboardEvent, type ReactElement, useEffect, useId, useRef, useState } from "react";
import { gsap, useGSAP } from "@/components/motion/gsap";
import logo from "../../../public/assets/nobg_logo.png";
import type { AgentSlide } from "./agent-data";
import { AgentIcon } from "./agent-icons";
import { SceneCycle } from "./agent-loop";
import { AgentScene } from "./agent-scenes";

const STROKE = { strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;

export interface AgentSlideWithLink extends AgentSlide {
  /** Built on the server: the app's create link for this agent type. */
  readonly href: string;
}

/** The agent's profile: the Wrenai mark (no tile), its name, and a link to set it up. */
function Profile({ agent }: { readonly agent: AgentSlideWithLink }): ReactElement {
  return (
    <div data-slide-part className="relative flex items-center gap-2.5">
      <Image src={logo} alt="" height={24} className="h-6 w-auto shrink-0" />
      {/* The name on one line; the description is for screen readers, the scene shows it. */}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-body font-medium text-fg-strong">{agent.name}</h3>
        <p className="sr-only">{agent.text}</p>
      </div>
      <a href={agent.href} aria-label={`Create a ${agent.name} agent in the app`} className="agent-open">
        <ArrowUpRight size={16} {...STROKE} />
      </a>
    </div>
  );
}

/**
 * The agents, one at a time: the list on the left selects one, the arrows step through them, and the panel on the
 * right shows its example setup. A new slide eases in from the side it came from; reduced motion swaps instantly.
 */
export function AgentSlides({
  agents,
}: {
  readonly agents: readonly AgentSlideWithLink[];
}): ReactElement | null {
  const [active, setActive] = useState(0);
  // Rotation follows each scene's lifecycle: when its loop finishes a pass, the next agent eases in. Any choice
  // the user makes stops it for good, and pointing at or focusing the carousel pauses it (WCAG 2.2.2).
  const [rotating, setRotating] = useState(true);
  const held = useRef(false);
  const layout = useRef<HTMLDivElement>(null);
  const direction = useRef(1);
  const panel = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const base = useId();
  const agent = agents[active] ?? agents[0];

  function show(next: number): void {
    const target = (next + agents.length) % agents.length;
    if (target === active) {
      return;
    }
    direction.current = next > active ? 1 : -1;
    setActive(target);
  }
  /** A selection by the user: it also ends the rotation. */
  function choose(next: number): void {
    setRotating(false);
    show(next);
  }
  function onSceneCycle(): void {
    if (rotating && !held.current) {
      show(active + 1);
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const next = (index + step + agents.length) % agents.length;
    choose(next);
    items.current[next]?.focus();
  }

  // Pointing at or focusing the carousel holds the rotation. Native listeners on the container: they only set a
  // ref, so nothing re-renders, and the container itself stays a plain, non-interactive element.
  useEffect(() => {
    const element = layout.current;
    if (!element) {
      return;
    }
    const hold = (): void => {
      held.current = true;
    };
    const release = (): void => {
      held.current = false;
    };
    const leaveFocus = (event: FocusEvent): void => {
      if (!(event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) {
        release();
      }
    };
    element.addEventListener("pointerenter", hold);
    element.addEventListener("pointerleave", release);
    element.addEventListener("focusin", hold);
    element.addEventListener("focusout", leaveFocus);
    return () => {
      element.removeEventListener("pointerenter", hold);
      element.removeEventListener("pointerleave", release);
      element.removeEventListener("focusin", hold);
      element.removeEventListener("focusout", leaveFocus);
    };
  }, []);

  useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        const parts = panel.current?.querySelectorAll("[data-slide-part]");
        if (!parts?.length) {
          return;
        }
        gsap.fromTo(
          parts,
          { autoAlpha: 0, x: 24 * direction.current },
          {
            autoAlpha: 1,
            x: 0,
            duration: 0.9,
            ease: "expo.out",
            stagger: 0.07,
            clearProps: "transform,opacity",
          },
        );
      });
      return () => media.revert();
    },
    { dependencies: [active], scope: panel, revertOnUpdate: true },
  );

  if (!agent) {
    return null;
  }
  return (
    <div ref={layout} className="agent-layout">
      {/* From lg the list and its arrows sit together at the top, level with the panel. Below lg the list is
          hidden and this wrapper dissolves (contents), so the arrows become their own grid item, centered under
          the panel (agent-arrows). */}
      <div className="max-lg:contents lg:flex lg:flex-col lg:gap-8">
        <div
          role="tablist"
          aria-label="Agents"
          aria-orientation="vertical"
          className="agent-list hidden lg:flex"
        >
          {agents.map((item, index) => (
            <button
              key={item.pack}
              ref={(node) => {
                items.current[index] = node;
              }}
              id={`${base}-tab-${item.pack}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              aria-controls={`${base}-panel`}
              tabIndex={index === active ? 0 : -1}
              onClick={() => choose(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className="agent-item"
            >
              <span className="agent-item-tile">
                <AgentIcon pack={item.pack} />
              </span>
              {item.name}
            </button>
          ))}
        </div>
        <div className="agent-arrows flex items-center gap-3">
          <button
            type="button"
            aria-label="Previous agent"
            onClick={() => choose(active - 1)}
            className="agent-arrow"
          >
            <ChevronLeft size={18} {...STROKE} />
          </button>
          <button
            type="button"
            aria-label="Next agent"
            onClick={() => choose(active + 1)}
            className="agent-arrow"
          >
            <ChevronRight size={18} {...STROKE} />
          </button>
        </div>
      </div>
      <div
        ref={panel}
        id={`${base}-panel`}
        role="tabpanel"
        aria-labelledby={`${base}-tab-${agent.pack}`}
        // Silent while rotating, so screen readers aren't interrupted every pass; announced once the user leads.
        aria-live={rotating ? "off" : "polite"}
        className="agent-panel relative flex flex-col gap-3 overflow-hidden"
      >
        <div aria-hidden="true" className="agent-panel-pattern pointer-events-none absolute inset-0" />
        <Profile agent={agent} />
        <div className="agent-stage relative">
          <SceneCycle value={onSceneCycle}>
            <AgentScene pack={agent.pack} />
          </SceneCycle>
        </div>
      </div>
    </div>
  );
}
