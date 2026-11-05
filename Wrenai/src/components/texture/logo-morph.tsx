"use client";

import gsap from "gsap";
import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "@/components/motion/use-prefers-reduced-motion";
import logo from "../../../public/assets/nobg_logo.png";
import {
  type DotGrid,
  dotDistances,
  logoTexture,
  type ShapeBox,
  type ShapeTexture,
  sampleDistance,
  sampleTone,
  shapeBox,
  shapeTextures,
} from "./morph-shapes";

// The sign-in pane's halftone (Docs/DESIGN.md → Visual pane): the logo drawn in dots, then a seamless loop through
// other shapes and back while the outer part turns slowly. The dots stay on their grid; the shape moves through
// them. One canvas, no DOM node per dot. Runs on GSAP's ticker at 30 fps, pauses off-screen, and holds the logo
// still and upright under reduced motion.

const BASE_PITCH = 9;
// Enough for a full pane (about 440 × 530 px) at the base pitch; larger areas widen the pitch.
const MAX_DOTS = 3200;
const MAX_PIXEL_RATIO = 2;
const FRAME_INTERVAL_S = 1 / 30;
// Each shape holds, then morphs into the next; the last morphs back into the logo, so the loop never pauses.
const HOLD_S = 2.4;
const MORPH_S = 2;
const STEP_S = HOLD_S + MORPH_S;
// Width of an outline's soft edge, in dot pitches: one ring of partial dots, so edges read clean, not jagged.
const EDGE_PITCHES = 0.9;
const BREATH_PERIOD_S = 4.2;
// The eye stays still and only the outer ring turns, like the Jarvis mark (styles/chat.css: the eye ends at 57–59%
// of the mark's half-width). Rotation fades in across the gap between eye and ring, as shares of the box's half
// side, so no shape shows a seam.
const EYE_STILL = 0.48;
const RING_TURNS = 0.6;
const ALPHA_LEVELS = 4;
// Below this coverage a dot belongs to the faint resting grid, not the shape.
const FLOOR = 0.06;
const FLOOR_RADIUS = 0.7;
const FLOOR_ALPHA = 0.14;
const TAU = Math.PI * 2;

interface Scene {
  readonly grid: DotGrid;
  readonly box: ShapeBox;
  readonly shapes: readonly ShapeTexture[];
  readonly distance: Float32Array;
}

function gridFor(width: number, height: number): DotGrid {
  let pitch = BASE_PITCH;
  while (Math.ceil(width / pitch) * Math.ceil(height / pitch) > MAX_DOTS) {
    pitch += 1;
  }
  return { width, height, pitch, columns: Math.ceil(width / pitch), rows: Math.ceil(height / pitch) };
}

function sceneFor(width: number, height: number, image: HTMLImageElement | null): Scene {
  const grid = gridFor(width, height);
  const box = shapeBox(grid);
  const mark = image ? logoTexture(grid, box, image) : null;
  const shapes = shapeTextures(grid, box);
  return { grid, box, shapes: mark ? [mark, ...shapes] : shapes, distance: dotDistances(grid, box) };
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function easeInOut(t: number): number {
  const clamped = clamp01(t);
  return clamped * clamped * (3 - 2 * clamped);
}

// Sine ease: zero speed at both ends, so a morph starts and settles without a jolt.
function easeMorph(t: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));
}

function drawFrame(context: CanvasRenderingContext2D, scene: Scene, color: string, timeS: number): void {
  const { grid, box, shapes, distance } = scene;
  const step = Math.floor(timeS / STEP_S);
  const from = shapes[step % shapes.length];
  const to = shapes[(step + 1) % shapes.length];
  if (from === undefined || to === undefined) {
    return;
  }
  // Every dot morphs together, so there is one outline at every moment.
  const mix = easeMorph((timeS - step * STEP_S - HOLD_S) / MORPH_S);
  // One steady turn per loop, so the angle never jumps when the loop repeats.
  const turn = (timeS / (shapes.length * STEP_S)) * TAU;
  const levels = Array.from({ length: ALPHA_LEVELS }, () => new Path2D());
  const floor = new Path2D();
  const maxRadius = grid.pitch * 0.46;
  for (let index = 0; index < distance.length; index += 1) {
    const reach = distance[index] ?? 0;
    const x = (index % grid.columns) * grid.pitch + grid.pitch / 2;
    const y = Math.floor(index / grid.columns) * grid.pitch + grid.pitch / 2;
    // Sample the shapes at the dot's position turned back by the ring's angle, in dot pitches from the center.
    const angle = turn * easeInOut((reach - EYE_STILL) / (RING_TURNS - EYE_STILL));
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const du = (x - box.x) / grid.pitch;
    const dv = (y - box.y) / grid.pitch;
    const u = cos * du + sin * dv;
    const v = cos * dv - sin * du;
    const startEdge = sampleDistance(from, u, v);
    const edge = startEdge + (sampleDistance(to, u, v) - startEdge) * mix;
    const startTone = sampleTone(from, u, v);
    const tone = startTone + (sampleTone(to, u, v) - startTone) * mix;
    const value = clamp01(0.5 - edge / EDGE_PITCHES) * tone;
    if (value < FLOOR) {
      floor.moveTo(x + FLOOR_RADIUS, y);
      floor.arc(x, y, FLOOR_RADIUS, 0, TAU);
      continue;
    }
    // A slow pulse travels outward from the center, so a held shape still breathes.
    const breath = 0.94 + 0.06 * Math.sin((timeS / BREATH_PERIOD_S) * TAU - reach * 5);
    // Dot area, not radius, follows coverage, as in print halftone.
    const radius = Math.max(maxRadius * Math.sqrt(value) * breath, FLOOR_RADIUS);
    const path = levels[Math.min(ALPHA_LEVELS - 1, Math.floor(value * ALPHA_LEVELS))];
    path?.moveTo(x + radius, y);
    path?.arc(x, y, radius, 0, TAU);
  }
  context.clearRect(0, 0, grid.width, grid.height);
  context.fillStyle = color;
  context.globalAlpha = FLOOR_ALPHA;
  context.fill(floor);
  levels.forEach((path, level) => {
    context.globalAlpha = 0.45 + (0.55 * (level + 1)) / ALPHA_LEVELS;
    context.fill(path);
  });
  context.globalAlpha = 1;
}

export function LogoMorph({ className }: { readonly className?: string }) {
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
    let size: { readonly width: number; readonly height: number } | null = null;
    let image: HTMLImageElement | null = null;
    let imageSettled = false;
    let scene: Scene | null = null;
    let visible = true;
    let disposed = false;
    let lastFrameS = 0;
    // The loop's clock starts at the first drawn frame, so it always opens on the logo's hold.
    let originS: number | null = null;

    function render(timeS: number): void {
      if (scene === null || canvas === null || context === null || context === undefined) {
        return;
      }
      originS ??= timeS;
      drawFrame(context, scene, color, timeS - originS);
      canvas.setAttribute("data-ready", "true");
    }

    // Waits for the logo, so the loop always opens on the mark rather than switching to it mid-loop.
    function rebuild(): void {
      if (size === null || !imageSettled) {
        return;
      }
      scene = sceneFor(size.width, size.height, image);
      render(lastFrameS);
    }

    function resize(width: number, height: number): void {
      if (canvas === null || context === null || context === undefined || width === 0 || height === 0) {
        return;
      }
      const ratio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      size = { width, height };
      rebuild();
    }

    function tick(timeS: number): void {
      if (!visible || timeS - lastFrameS < FRAME_INTERVAL_S) {
        return;
      }
      lastFrameS = timeS;
      render(timeS);
    }

    const mark = new Image();
    mark.src = logo.src;
    mark
      .decode()
      .then(() => {
        image = mark;
      })
      // Without the image the loop runs through the drawn shapes only; the pane is decoration either way.
      .catch(() => {
        image = null;
      })
      .finally(() => {
        if (!disposed) {
          imageSettled = true;
          rebuild();
        }
      });

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
      disposed = true;
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
