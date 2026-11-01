"use client";

import gsap from "gsap";
import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "@/components/motion/use-prefers-reduced-motion";

// Signature texture, animated: Docs/DESIGN.md → Textures and patterns.
// One canvas, no DOM node per dot. Runs on GSAP's ticker at 30 fps, pauses off-screen, and draws a single
// still frame when the user asks for reduced motion.

const BASE_PITCH = 12;
// Enough for a full visual pane (about 440 × 530 px) at the base pitch; larger areas widen the pitch.
const MAX_DOTS = 2000;
const MAX_PIXEL_RATIO = 2;
const FRAME_INTERVAL_S = 1 / 30;
const EMPTY_LEAD = 0.15;
const GROWTH_EXPONENT = 1.6;
const MIN_RADIUS = 0.4;
const ALPHA_LEVELS = 4;
const RIPPLE_WAVELENGTH = 220;
const RIPPLE_PERIOD_S = 7;
const SWELL_WAVELENGTH = 130;
const SWELL_PERIOD_S = 11;
const TAU = Math.PI * 2;

interface Grid {
  readonly width: number;
  readonly height: number;
  readonly pitch: number;
  readonly columns: number;
  readonly rows: number;
}

function gridFor(width: number, height: number): Grid {
  let pitch = BASE_PITCH;
  while (Math.ceil(width / pitch) * Math.ceil(height / pitch) > MAX_DOTS) {
    pitch += 1;
  }
  return { width, height, pitch, columns: Math.ceil(width / pitch), rows: Math.ceil(height / pitch) };
}

function drawFrame(context: CanvasRenderingContext2D, grid: Grid, color: string, timeS: number): void {
  const levels = Array.from({ length: ALPHA_LEVELS }, () => new Path2D());
  const maxRadius = grid.pitch * 0.42;
  for (let column = 0; column < grid.columns; column += 1) {
    const x = column * grid.pitch + grid.pitch / 2;
    const growth =
      Math.min(Math.max((x / grid.width - EMPTY_LEAD) / (1 - EMPTY_LEAD), 0), 1) ** GROWTH_EXPONENT;
    if (growth === 0) {
      continue;
    }
    for (let row = 0; row < grid.rows; row += 1) {
      const y = row * grid.pitch + grid.pitch / 2;
      const ripple = 0.5 + 0.5 * Math.sin((x / RIPPLE_WAVELENGTH - timeS / RIPPLE_PERIOD_S) * TAU + y / 40);
      const swell = 0.5 + 0.5 * Math.sin((y / SWELL_WAVELENGTH + timeS / SWELL_PERIOD_S) * TAU);
      const pulse = 0.6 * ripple + 0.4 * swell;
      const radius = maxRadius * growth * (0.55 + 0.45 * pulse);
      const path = levels[Math.min(ALPHA_LEVELS - 1, Math.floor(pulse * ALPHA_LEVELS))];
      if (radius < MIN_RADIUS || path === undefined) {
        continue;
      }
      path.moveTo(x + radius, y);
      path.arc(x, y, radius, 0, TAU);
    }
  }
  context.clearRect(0, 0, grid.width, grid.height);
  context.fillStyle = color;
  levels.forEach((path, level) => {
    context.globalAlpha = 0.5 + (0.5 * (level + 1)) / ALPHA_LEVELS;
    context.fill(path);
  });
  context.globalAlpha = 1;
}

export function LiveHalftone({ className }: { readonly className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas === null || context === null || context === undefined) {
      return;
    }
    // The dot color comes from the canvas's CSS color, so the texture tokens stay in globals.css.
    const color = getComputedStyle(canvas).color;
    let grid: Grid | null = null;
    let visible = true;
    let lastFrameS = 0;

    function render(timeS: number): void {
      if (grid === null || canvas === null || context === null || context === undefined) {
        return;
      }
      drawFrame(context, grid, color, timeS);
      canvas.setAttribute("data-ready", "true");
    }

    function resize(width: number, height: number): void {
      if (canvas === null || context === null || context === undefined || width === 0 || height === 0) {
        return;
      }
      const ratio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      grid = gridFor(width, height);
      render(lastFrameS);
    }

    function tick(timeS: number): void {
      if (!visible || timeS - lastFrameS < FRAME_INTERVAL_S) {
        return;
      }
      lastFrameS = timeS;
      render(timeS);
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        resize(entry.contentRect.width, entry.contentRect.height);
      }
    });
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
    });
    resizeObserver.observe(canvas);
    visibilityObserver.observe(canvas);
    if (!reducedMotion) {
      gsap.ticker.add(tick);
    }
    return () => {
      gsap.ticker.remove(tick);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
    };
  }, [reducedMotion]);

  // The wrapper carries aria-hidden and layout; the canvas inherits its color and fills it.
  return (
    <div aria-hidden="true" className={`pointer-events-none ${className ?? ""}`}>
      <canvas
        ref={canvasRef}
        className="block h-full w-full opacity-0 transition-opacity duration-700 data-[ready=true]:opacity-100"
      />
    </div>
  );
}
