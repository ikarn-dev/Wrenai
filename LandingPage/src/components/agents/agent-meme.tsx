"use client";

import { type ReactElement, useRef } from "react";
import { useSceneLoop } from "./agent-loop";

// How Meme Hunter hunts, played as a loop: new Nearly launches arrive from Squint, each is run through the rules
// from the app's example setup (agent-templates.ts), and only a launch that passes every check is bought. The
// launches are made-up examples, labeled as such; no real token, metric or result is implied.

const FEED = [
  { id: "moss", ticker: "$MOSS", verdict: "Skipped" },
  { id: "fig", ticker: "$FIG", verdict: "Skipped" },
  { id: "wren", ticker: "$WREN", verdict: "Checking" },
] as const;

const CHECKS = [
  { id: "age", label: "Launch age", rule: "Under 12 h" },
  { id: "liquidity", label: "Liquidity", rule: "$3,000 or more" },
  { id: "holders", label: "Top holder or group", rule: "10% at most" },
  { id: "impact", label: "Price impact", rule: "2% at most" },
] as const;

/** The live scan: the feed fills, each rule resolves in turn under a sweeping scan line, then the buy. */
export function MemeHunt(): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  useSceneLoop(
    root,
    (timeline, element) => {
      timeline
        .fromTo(
          element.querySelectorAll("[data-feed]"),
          { autoAlpha: 0, x: -10 },
          { autoAlpha: 1, x: 0, duration: 0.5, ease: "power2.out", stagger: 0.35 },
          0,
        )
        .fromTo(
          element.querySelector("[data-scan]"),
          { yPercent: -100, autoAlpha: 0 },
          { yPercent: 400, autoAlpha: 1, duration: 2.6, ease: "none" },
          1.1,
        )
        .to(element.querySelector("[data-scan]"), { autoAlpha: 0, duration: 0.3 }, 3.6);
      for (const [index, check] of CHECKS.entries()) {
        timeline.fromTo(
          element.querySelector(`[data-check="${check.id}"]`),
          { "--lit": 0 },
          { "--lit": 1, duration: 0.35, ease: "power2.out" },
          1.3 + index * 0.6,
        );
      }
      timeline
        .fromTo(
          element.querySelector("[data-verdict]"),
          { autoAlpha: 0, scale: 0.85 },
          { autoAlpha: 1, scale: 1, duration: 0.5, ease: "back.out(2)" },
          4,
        )
        .to(element.querySelectorAll("[data-check]"), { "--lit": 0, duration: 0.8 }, 6.2)
        .to(element.querySelector("[data-verdict]"), { autoAlpha: 0, duration: 0.4 }, 6.2);
    },
    2.4,
  );

  return (
    <div ref={root} data-slide-part className="flex flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-small text-fg-subtle">Squint feed</span>
        <ul className="flex min-w-0 gap-1.5 overflow-hidden" aria-label="Example launches">
          {FEED.map((item) => (
            <li
              key={item.id}
              data-feed=""
              className="agent-feed"
              data-current={item.id === "wren" ? "" : undefined}
            >
              {item.ticker}
              <span className="text-fg-subtle">{item.verdict}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="agent-scene relative flex-1 overflow-hidden">
        <span aria-hidden="true" data-scan="" className="agent-scan" />
        <div className="flex items-center gap-3 pb-2">
          <span aria-hidden="true" className="agent-coin">
            W
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-medium text-fg-strong">$WREN</span>
            <span className="text-small text-fg-subtle">Example Nearly launch</span>
          </div>
          <span data-verdict="" className="agent-verdict">
            Buy
          </span>
        </div>
        {CHECKS.map((check) => (
          <div key={check.id} data-check={check.id} className="agent-row agent-check-row">
            <span className="text-body text-fg-subtle">{check.label}</span>
            <span className="flex items-center gap-2 text-body text-fg">
              <span className="agent-check" />
              {check.rule}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
