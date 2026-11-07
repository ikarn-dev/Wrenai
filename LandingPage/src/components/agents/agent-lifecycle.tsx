"use client";

import { ArrowLeftRight, CircleCheck, Clock3, Crosshair, Shield } from "lucide-react";
import { type ReactElement, type ReactNode, type RefObject, useRef, useState } from "react";
import { gsap } from "@/components/motion/gsap";
import { useSceneLoop } from "./agent-loop";
import { type Phase, PhaseFlow, runPhases } from "./agent-phase-flow";

// How three agents run, played as loops. The steps follow the app: a payment is reserved, signed with the agent
// key, submitted through NEAR Intents' 1Click API and closed only on its final status (server/execution); DCA
// slots start at
// the start time and repeat every interval, a slot over a minute late is skipped (engine/dca-schedule.ts); every
// order gets a fresh quote and the Guard's check before signing. Each step warms as it is reached (--lit); the
// still state, shown under reduced motion, is the finished run.

interface Step {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

const PAYMENT_STEPS: readonly Step[] = [
  { id: "reserved", label: "Reserved", detail: "The exact amount is held for it" },
  { id: "signed", label: "Signed", detail: "With your agent key" },
  { id: "sent", label: "Sent", detail: "Submitted through NEAR Intents" },
  { id: "delivered", label: "Delivered", detail: "Final status from NEAR Intents" },
];

const DCA_SLOTS = ["Start", "12 h", "24 h", "36 h"] as const;
const DCA_STEPS: readonly Phase[] = [
  { id: "due", label: "Due", detail: "Every 12 h", icon: Clock3 },
  { id: "quote", label: "Quote", detail: "Fresh price", icon: ArrowLeftRight },
  { id: "guard", label: "Guard", detail: "Your limits", icon: Shield },
  { id: "bought", label: "Bought", detail: "Then waits", icon: CircleCheck },
];

const SPOT_STEPS: readonly Phase[] = [
  { id: "quote", label: "Quote", detail: "Fresh price", icon: ArrowLeftRight },
  { id: "guard", label: "Guard", detail: "Your limits", icon: Shield },
  { id: "bought", label: "Bought", detail: "At market", icon: CircleCheck },
  { id: "exits", label: "Exits", detail: "Every 5 s", icon: Crosshair },
];

/**
 * Spot's example exits, in percent from the buy. The template leaves both prices to the user, so these are
 * illustrations, labeled "Example" on the card; the price's path is drawn, not market data.
 */
const STOP_LOSS = -5;
const TAKE_PROFIT = 10;

/** A scene card for a lifecycle: a title and an optional detail, then the steps filling the rest. */
function LifecycleCard({
  title,
  aside,
  root,
  children,
}: {
  readonly title: string;
  readonly aside?: string;
  readonly root: RefObject<HTMLDivElement | null>;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div ref={root} data-slide-part className="agent-scene flex-1">
      <div className="flex items-center justify-between gap-3 pb-2">
        <span className="text-body font-medium text-fg-strong">{title}</span>
        {aside ? <span className="text-small text-fg-subtle">{aside}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** The payment's status: four steps down a rail that fills as each one completes. */
export function PaymentLifecycle(): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  useSceneLoop(root, (timeline, element) => {
    const steps = Array.from(element.querySelectorAll("[data-step]"));
    const lines = Array.from(element.querySelectorAll("[data-step-fill]"));
    gsap.set(steps, { "--lit": 0 });
    gsap.set(lines, { scaleY: 0 });
    // Each step's mark, name and detail light together (one --lit); the rail then fills down to the next mark and
    // that step lights on the frame the fill arrives.
    const hold = 0.35;
    const travel = 0.6;
    for (const [index, step] of steps.entries()) {
      const at = 0.3 + index * (hold + travel);
      timeline.to(step, { "--lit": 1, duration: 0.3, ease: "power2.out" }, at);
      const line = lines[index];
      if (line) {
        timeline.to(line, { scaleY: 1, duration: travel, ease: "none" }, at + hold);
      }
    }
    timeline.to(steps, { "--lit": 0, duration: 0.6 }, "+=1.8").to(lines, { scaleY: 0, duration: 0.6 }, "<");
  });

  return (
    <LifecycleCard title="Status" root={root}>
      <ol className="flex flex-1 flex-col">
        {PAYMENT_STEPS.map((step, index) => (
          <li key={step.id} data-step="" className="agent-step">
            {index < PAYMENT_STEPS.length - 1 ? (
              <span aria-hidden="true" className="agent-step-line">
                <span data-step-fill="" />
              </span>
            ) : null}
            <span aria-hidden="true" className="agent-step-dot" />
            {/* The step left, what it means right, like the Payment card's rows above. */}
            <span className="shrink-0 text-body">{step.label}</span>
            <span className="agent-step-detail ml-auto min-w-0 text-right text-body">{step.detail}</span>
          </li>
        ))}
      </ol>
    </LifecycleCard>
  );
}

/** The DCA schedule: the playhead moves slot to slot, and each slot runs its buy through the pipeline. */
export function DcaLifecycle(): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState<string | null>(null);
  useSceneLoop(
    root,
    (timeline, element) => {
      const slots = Array.from(element.querySelectorAll("[data-slot]"));
      const phases = Array.from(element.querySelectorAll("[data-phase]"));
      const fill = element.querySelector("[data-slot-fill]");
      gsap.set([...slots, ...phases], { "--lit": 0 });
      if (fill) {
        gsap.set(fill, { scaleX: 0 });
      }
      for (const [index, slot] of slots.entries()) {
        const at = index * 2.6;
        if (fill && index > 0) {
          timeline.to(fill, { scaleX: index / (slots.length - 1), duration: 0.6, ease: "power1.inOut" }, at);
        }
        timeline.to(slot, { "--lit": 1, duration: 0.3 }, at + 0.5);
        runPhases(timeline, element, at + 0.7, 0.4);
        timeline.to(phases, { "--lit": 0, duration: 0.3 }, at + 2.4);
      }
      timeline.to(slots, { "--lit": 0, duration: 0.6 }, "+=1.2");
      if (fill) {
        timeline.to(fill, { scaleX: 0, duration: 0.6 }, "<");
      }
    },
    1,
    drawn,
  );

  return (
    <LifecycleCard title="Schedule" root={root}>
      <div className="flex flex-1 flex-col justify-between gap-3">
        <div className="relative">
          <span aria-hidden="true" className="agent-slots-track">
            <span data-slot-fill="" />
          </span>
          <ol aria-label="Buys" className="agent-slots">
            {DCA_SLOTS.map((slot) => (
              <li key={slot} data-slot="" className="agent-slot">
                <span aria-hidden="true" className="agent-step-dot" />
                <span className="text-small tabular-nums">{slot}</span>
              </li>
            ))}
          </ol>
        </div>
        <PhaseFlow steps={DCA_STEPS} onDrawn={setDrawn} />
      </div>
    </LifecycleCard>
  );
}

/** A signed percentage with a real minus sign: "+4.00%", "−3.00%", "0.00%"; levels pass 0 digits ("−5%"). */
function signedPercent(value: number, digits = 2): string {
  if (Math.abs(value) < 0.005) {
    return `${(0).toFixed(digits)}%`;
  }
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}%`;
}
function sign(value: number): "gain" | "loss" | "flat" {
  return Math.abs(value) < 0.005 ? "flat" : value > 0 ? "gain" : "loss";
}

/**
 * Plays the armed exits: the price wanders from the buy into loss and profit, the live result badge counting with
 * it, then reaches the take profit, whose badge answers. The mover spans the strip, so 50% of its width is one
 * half of the strip: the left half runs to the stop loss, the right half to the take profit.
 */
function runExits(timeline: gsap.core.Timeline, element: HTMLElement, at: number): void {
  const price = element.querySelector("[data-price]");
  const result = element.querySelector("[data-result]");
  const target = element.querySelector("[data-take-profit]");
  if (!price || !result) {
    return;
  }
  const showResult = (): void => {
    const x = Number(gsap.getProperty(price, "xPercent"));
    const value = x >= 0 ? (x / 50) * TAKE_PROFIT : (x / 50) * -STOP_LOSS;
    result.textContent = signedPercent(value);
    result.setAttribute("data-sign", sign(value));
  };
  timeline.to(
    price,
    {
      keyframes: [{ xPercent: 20 }, { xPercent: -30 }, { xPercent: 12 }, { xPercent: 50 }],
      duration: 3.2,
      ease: "sine.inOut",
      onUpdate: showResult,
    },
    at,
  );
  if (target) {
    timeline.fromTo(
      target,
      { scale: 1 },
      { scale: 1.12, duration: 0.25, ease: "power2.out", yoyo: true, repeat: 1, immediateRender: false },
      ">",
    );
  }
  timeline.to(price, { xPercent: 0, duration: 0.8, ease: "power2.inOut", onUpdate: showResult }, "+=1.4");
}

/**
 * The spot order: quote, Guard, the buy, then the armed exits, watched on a strip from the stop loss (red half)
 * through the buy to the take profit (mint half), with the live result above the price.
 */
export function SpotLifecycle(): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState<string | null>(null);
  useSceneLoop(
    root,
    (timeline, element) => {
      const phases = Array.from(element.querySelectorAll("[data-phase]"));
      gsap.set(phases, { "--lit": 0 });
      runPhases(timeline, element, 0.3, 0.8);
      const exits = phases[phases.length - 1];
      const watch = 0.3 + (phases.length - 1) * 0.8 + 0.4;
      if (exits) {
        // Armed exits keep being checked: the last step breathes while the price is watched.
        timeline.to(
          exits,
          { "--lit": 0.45, duration: 0.6, ease: "sine.inOut", yoyo: true, repeat: 3 },
          watch,
        );
      }
      runExits(timeline, element, watch);
      timeline.to(phases, { "--lit": 0, duration: 0.6 }, "+=0.4");
    },
    2.2,
    drawn,
  );

  return (
    <LifecycleCard title="Order" aside="Example" root={root}>
      <div className="flex flex-1 flex-col justify-between gap-3">
        <PhaseFlow steps={SPOT_STEPS} onDrawn={setDrawn} />
        {/* Room above the strip for the live result riding over the price. */}
        <div className="flex items-center gap-2.5 pt-7">
          <span data-sign="loss" className="agent-badge">
            SL {signedPercent(STOP_LOSS, 0)}
          </span>
          <span className="agent-range">
            <span data-price="">
              <span data-result="" data-sign="flat" className="agent-badge agent-result">
                {signedPercent(0)}
              </span>
            </span>
          </span>
          <span data-sign="gain" data-take-profit="" className="agent-badge">
            TP {signedPercent(TAKE_PROFIT, 0)}
          </span>
        </div>
      </div>
    </LifecycleCard>
  );
}
