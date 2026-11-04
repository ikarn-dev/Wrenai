import type { ReactElement } from "react";

const SPOKES = [0, 1, 2, 3, 4, 5, 6, 7] as const;
const PERIOD_S = 0.8;

interface ActivityIndicatorProps {
  /** Diameter in pixels. */
  readonly size?: number;
  /** What is happening, for screen readers ("Refreshing quote"). */
  readonly label: string;
}

/**
 * The iOS activity indicator: eight rounded spokes in currentColor, each fading from full to faint in turn, so
 * the light appears to travel round the circle. Opacity only, on the compositor. Under reduced motion the spokes
 * stand still at their stepped opacities, which still reads as "working".
 */
export function ActivityIndicator({ size = 16, label }: ActivityIndicatorProps): ReactElement {
  return (
    <span role="status" className="inline-flex shrink-0 items-center justify-center">
      <span aria-hidden="true" className="relative block" style={{ width: size, height: size }}>
        {SPOKES.map((spoke) => (
          <span
            key={spoke}
            className="activity-spoke absolute top-0 left-1/2 h-[30%] w-[9%] min-w-[1.5px] -translate-x-1/2 rounded-full bg-current"
            style={{
              transformOrigin: `50% ${size / 2}px`,
              rotate: `${spoke * 45}deg`,
              animationDelay: `${(spoke - SPOKES.length) * (PERIOD_S / SPOKES.length)}s`,
              opacity: 1 - spoke * 0.1,
            }}
          />
        ))}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
