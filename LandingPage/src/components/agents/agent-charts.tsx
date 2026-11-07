"use client";

import { type ReactElement, type RefObject, useRef } from "react";
import { useSceneLoop } from "./agent-loop";

// Illustrative candle charts for the agent scenes. The candles are drawn shapes, not market data: they show how an
// agent reads price against its levels. Up candles are mint, down candles grey (loss red is kept for losses and
// errors, DESIGN.md → Status). Plain lines are reference lines; striped lines are the levels the agent acts on.

export interface Candle {
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}
export interface ChartLine {
  readonly id: string;
  /** Price on the chart's own 0–100 scale. */
  readonly p: number;
  readonly kind: "plain" | "striped";
  readonly label?: string;
}
export interface ChartMarker {
  readonly id: string;
  /** The candle it sits on, and the price it marks. */
  readonly at: number;
  readonly p: number;
  readonly label: string;
  /** The level it reaches, whose label lights when it lands. */
  readonly line?: string;
}

const W = 320;
const H = 120;
const PAD = 6;
/**
 * The chart's vertical scale, fitted to what it draws: the candles' range and every level, with headroom above for
 * a marker's label. So the candles fill the chart instead of leaving an empty band below or above them.
 */
function priceScale(
  candles: readonly Candle[],
  lines: readonly ChartLine[],
  markers: readonly ChartMarker[],
): (p: number) => number {
  const prices = [...candles.flatMap((candle) => [candle.h, candle.l]), ...lines.map((line) => line.p)];
  const low = Math.min(...prices) - 3,
    high = Math.max(...prices, ...markers.map((marker) => marker.p + 10)) + 2;
  return (p) => PAD + ((high - p) / (high - low)) * (H - PAD * 2);
}
function xAt(index: number, count: number): number {
  const step = (W - 72) / count;
  return 8 + step * (index + 0.5);
}

/** A simple moving average of the closes, drawn as one path. */
function averagePath(candles: readonly Candle[], span: number, y: (p: number) => number): string {
  return candles
    .map((_, index) => {
      const from = Math.max(0, index - span + 1),
        window = candles.slice(from, index + 1),
        mean = window.reduce((sum, candle) => sum + candle.c, 0) / window.length;
      return `${index === 0 ? "M" : "L"}${xAt(index, candles.length).toFixed(1)} ${y(mean).toFixed(1)}`;
    })
    .join(" ");
}

/**
 * Plays the chart: levels fade in, candles rise one by one while the average draws with them, markers pop on their
 * candle, then the last candle keeps ticking. Loops while on screen; reduced motion shows the finished chart.
 */
function useChartLoop(
  root: RefObject<HTMLDivElement | null>,
  count: number,
  markers: readonly ChartMarker[],
): void {
  useSceneLoop(
    root,
    (timeline, element) => {
      const step = 0.16;
      timeline.fromTo(
        element.querySelectorAll("[data-level]"),
        { autoAlpha: 0 },
        { autoAlpha: 1, duration: 0.6 },
        0,
      );
      timeline.fromTo(
        element.querySelectorAll("[data-candle]"),
        { autoAlpha: 0, y: 6 },
        { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out", stagger: step },
        0.2,
      );
      const average = element.querySelector("[data-average]");
      if (average) {
        timeline.fromTo(
          average,
          { strokeDashoffset: 1 },
          { strokeDashoffset: 0, duration: count * step + 0.4, ease: "none" },
          0.2,
        );
      }
      for (const marker of markers) {
        timeline.fromTo(
          element.querySelector(`[data-marker="${marker.id}"]`),
          { autoAlpha: 0, scale: 0.4 },
          { autoAlpha: 1, scale: 1, duration: 0.5, ease: "back.out(2.2)" },
          0.2 + marker.at * step + 0.3,
        );
      }
      // A level the price reaches lights its label as the marker lands.
      for (const marker of markers) {
        const label = marker.line ? element.querySelector(`[data-hit="${marker.line}"]`) : null;
        if (label) {
          timeline.fromTo(
            label,
            { "--lit": 0 },
            { "--lit": 1, duration: 0.35, yoyo: true, repeat: 1 },
            0.2 + marker.at * step + 0.3,
          );
        }
      }
      // The newest candle keeps ticking, as a live one does, growing and shrinking from its open.
      const live = element.querySelector("[data-live]");
      if (live) {
        timeline.to(
          live,
          {
            scaleY: 0.7,
            transformOrigin: "50% 100%",
            duration: 0.45,
            ease: "sine.inOut",
            yoyo: true,
            repeat: 5,
          },
          ">",
        );
      }
    },
    2.4,
  );
}

/** A candle chart that fills its box, with levels, an optional average and markers, labels on the right edge. */
export function CandleChart({
  candles,
  lines,
  markers = [],
  average = true,
}: {
  readonly candles: readonly Candle[];
  readonly lines: readonly ChartLine[];
  readonly markers?: readonly ChartMarker[];
  readonly average?: boolean;
}): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  useChartLoop(root, candles.length, markers);
  const width = ((W - 72) / candles.length) * 0.56,
    y = priceScale(candles, lines, markers);
  return (
    <div ref={root} className="agent-chart relative min-h-32 flex-1">
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 size-full"
      >
        {lines.map((line) => (
          <line
            key={line.id}
            data-level=""
            x1="0"
            x2={W}
            y1={y(line.p)}
            y2={y(line.p)}
            className={line.kind === "striped" ? "agent-level" : "agent-ref"}
          />
        ))}
        {candles.map((candle, index) => {
          const x = xAt(index, candles.length),
            top = y(Math.max(candle.o, candle.c)),
            bottom = y(Math.min(candle.o, candle.c)),
            rising = candle.c >= candle.o;
          return (
            <g
              key={`${x.toFixed(1)}-${candle.o}`}
              data-candle=""
              className={rising ? "agent-candle-up" : "agent-candle-down"}
            >
              <line x1={x} x2={x} y1={y(candle.h)} y2={y(candle.l)} />
              <rect
                x={x - width / 2}
                y={top}
                width={width}
                height={Math.max(1.5, bottom - top)}
                rx="0.8"
                {...(index === candles.length - 1 ? { "data-live": "" } : {})}
              />
            </g>
          );
        })}
        {average ? (
          <path data-average="" d={averagePath(candles, 3, y)} pathLength={1} className="agent-average" />
        ) : null}
      </svg>
      {lines
        .filter((line) => line.label)
        .map((line) => (
          <span
            key={line.id}
            data-hit={line.id}
            className="agent-level-label"
            style={{ top: `${(y(line.p) / H) * 100}%` }}
          >
            {line.label}
          </span>
        ))}
      {markers.map((marker) => (
        <span
          key={marker.id}
          data-marker={marker.id}
          className="agent-marker"
          style={{
            left: `${(xAt(marker.at, candles.length) / W) * 100}%`,
            top: `${(y(marker.p) / H) * 100}%`,
          }}
        >
          <span className="agent-marker-label">{marker.label}</span>
        </span>
      ))}
    </div>
  );
}
