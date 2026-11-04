import type { ReactElement } from "react";
import type { PortfolioHistoryPoint } from "@/server/portfolio/history";
import { formatCompactMicroUsd } from "@/shared/money";
import { maximumUnits, minimumUnits } from "@/shared/token-units";

export function historySegments(
  points: readonly PortfolioHistoryPoint[],
): readonly (readonly { readonly x: number; readonly y: number; readonly point: PortfolioHistoryPoint }[])[] {
  const known = points.flatMap((point) => (point.valueMicroUsd === null ? [] : [point.valueMicroUsd]));
  if (!known.length) {
    return [];
  }
  const first = points[0]?.at ?? 0,
    last = points.at(-1)?.at ?? first;
  const low = known.reduce(minimumUnits),
    high = known.reduce(maximumUnits),
    range = high - low;
  const segments: { x: number; y: number; point: PortfolioHistoryPoint }[][] = [];
  let segment: { x: number; y: number; point: PortfolioHistoryPoint }[] = [];
  for (const point of points) {
    if (point.valueMicroUsd === null) {
      if (segment.length) {
        segments.push(segment);
        segment = [];
      }
      continue;
    }
    const previous = segment.at(-1);
    if (previous && point.at - previous.point.at > 86400000) {
      segments.push(segment);
      segment = [];
    }
    segment.push({
      x: last === first ? 160 : 10 + Math.round(((point.at - first) * 300) / (last - first)),
      y: range === 0n ? 40 : 70 - Number(((point.valueMicroUsd - low) * 60n) / range),
      point,
    });
  }
  if (segment.length) {
    segments.push(segment);
  }
  return segments;
}
export function PortfolioHistoryChart({
  points,
}: {
  readonly points: readonly PortfolioHistoryPoint[];
}): ReactElement {
  const segments = historySegments(points);
  return (
    <div className="mt-4 border-t border-line pt-3">
      <p className="text-caption text-fg-muted">Portfolio value history</p>
      {segments.length ? (
        <svg
          viewBox="0 0 320 80"
          role="img"
          aria-label="Recorded portfolio values. Missing or incomplete observations appear as gaps."
          className="h-24 w-full text-accent-text"
        >
          {segments.map((segment) => (
            <g key={segment[0]?.point.at}>
              {segment.length > 1 ? (
                <polyline
                  points={segment.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              {segment.map(({ x, y, point }) => (
                <circle key={point.at} cx={x} cy={y} r={2} fill="currentColor">
                  <title>
                    {new Date(point.at).toISOString().slice(0, 16).replace("T", " ")} UTC ·{" "}
                    {point.valueMicroUsd === null
                      ? "Unavailable"
                      : formatCompactMicroUsd(point.valueMicroUsd)}
                  </title>
                </circle>
              ))}
            </g>
          ))}
        </svg>
      ) : (
        <p className="py-3 text-caption text-fg-subtle">History starts with your first complete valuation.</p>
      )}
      <p className="text-caption text-fg-subtle">
        Last 30 days · recorded when viewed. Deposits affect value, not trading PnL.
      </p>
    </div>
  );
}
