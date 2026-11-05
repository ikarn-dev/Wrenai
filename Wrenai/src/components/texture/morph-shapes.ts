// Shapes for the sign-in pane's logo morph (Docs/DESIGN.md → Visual pane). Each shape is a signed distance field
// centered on the shape box. Blending two distance fields gives one clean outline that reshapes smoothly, where
// blending coverage would show both shapes at half strength.

export interface DotGrid {
  readonly width: number;
  readonly height: number;
  readonly pitch: number;
  readonly columns: number;
  readonly rows: number;
}

/** The square every shape is drawn in, centered in the pane: center and half its side, in CSS pixels. */
export interface ShapeBox {
  readonly x: number;
  readonly y: number;
  readonly half: number;
}

export interface ShapeTexture {
  readonly size: number;
  /** Signed distance to the shape's edge in dot pitches, negative inside. */
  readonly distance: Float32Array;
  /** How full a dot is inside the shape: 1, or less on the logo's darker folds. */
  readonly tone: Float32Array;
}

// The shape's share of the pane's shorter side, leaving dark space around it.
const BOX_SHARE = 0.72;
// The texture reaches slightly past the box, so a turning shape never clips at its corners.
const TEXTURE_REACH = 1.08;
// Texels per dot pitch: finer than the dots, so outlines land between dots instead of snapping to them.
const RESOLUTION = 2;
// The logo is drawn at 3 × 3 samples per texel, then averaged.
const SUPERSAMPLE = 3;

export function shapeBox(grid: DotGrid): ShapeBox {
  return { x: grid.width / 2, y: grid.height / 2, half: (Math.min(grid.width, grid.height) * BOX_SHARE) / 2 };
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** Coverage of a signed distance (negative inside), softened over `edge`. */
function fill(distance: number, edge: number): number {
  return clamp01(0.5 - distance / edge);
}

// Signed distance to a hexagon with circumradius-like size `radius` (Inigo Quilez's exact 2D hexagon).
function hexagonDistance(u: number, v: number, radius: number): number {
  const kx = -0.866025404;
  const ky = 0.5;
  const kz = 0.577350269;
  let x = Math.abs(u);
  let y = Math.abs(v);
  const fold = 2 * Math.min(kx * x + ky * y, 0);
  x -= fold * kx;
  y -= fold * ky;
  x -= Math.min(Math.max(x, -kz * radius), kz * radius);
  y -= radius;
  return Math.hypot(x, y) * Math.sign(y);
}

/** u and v run from −1 to 1 across the shape box; y points down, so the top is v = −1. */
type Shape = (u: number, v: number, edge: number) => number;

// A ring around a still center dot, like the mark's eye.
const ring: Shape = (u, v, edge) => {
  const radius = Math.hypot(u, v);
  return Math.max(fill(Math.abs(radius - 0.74) - 0.17, edge), fill(radius - 0.2, edge));
};

// A rounded hexagon with an open center.
const hexagon: Shape = (u, v, edge) =>
  Math.max(0, fill(hexagonDistance(v, u, 0.74) - 0.08, edge) - fill(Math.hypot(u, v) - 0.3, edge));

const SHAPES: readonly Shape[] = [ring, hexagon];

function textureSize(grid: DotGrid, box: ShapeBox): number {
  return Math.ceil((2 * box.half * TEXTURE_REACH * RESOLUTION) / grid.pitch);
}

/**
 * Signed distance from each texel to the shape's edge, from a coverage map thresholded at one half. The nearest
 * texel of the other state is always on the boundary, so only boundary texels are searched.
 */
function signedDistance(size: number, coverage: Float32Array): Float32Array {
  const inside = (column: number, row: number): boolean =>
    column >= 0 && row >= 0 && column < size && row < size && (coverage[row * size + column] ?? 0) >= 0.5;
  // Flat x, y pairs of boundary texels on each side of the edge.
  const insideEdge: number[] = [];
  const outsideEdge: number[] = [];
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const self = inside(column, row);
      if (
        inside(column - 1, row) !== self ||
        inside(column + 1, row) !== self ||
        inside(column, row - 1) !== self ||
        inside(column, row + 1) !== self
      ) {
        (self ? insideEdge : outsideEdge).push(column, row);
      }
    }
  }
  const field = new Float32Array(size * size);
  for (let index = 0; index < field.length; index += 1) {
    const column = index % size;
    const row = Math.floor(index / size);
    const self = inside(column, row);
    const targets = self ? outsideEdge : insideEdge;
    let best = Number.POSITIVE_INFINITY;
    for (let k = 0; k < targets.length; k += 2) {
      const dx = (targets[k] ?? 0) - column;
      const dy = (targets[k + 1] ?? 0) - row;
      best = Math.min(best, dx * dx + dy * dy);
    }
    // The edge lies halfway between the two nearest texels of different states.
    const texels = (best === Number.POSITIVE_INFINITY ? size : Math.sqrt(best)) - 0.5;
    field[index] = (self ? -texels : texels) / RESOLUTION;
  }
  return field;
}

/** The shapes that follow the logo, in loop order. */
export function shapeTextures(grid: DotGrid, box: ShapeBox): readonly ShapeTexture[] {
  const size = textureSize(grid, box);
  const unit = grid.pitch / (box.half * RESOLUTION);
  return SHAPES.map((shape) => {
    const coverage = new Float32Array(size * size);
    for (let index = 0; index < coverage.length; index += 1) {
      const u = ((index % size) + 0.5 - size / 2) * unit;
      const v = (Math.floor(index / size) + 0.5 - size / 2) * unit;
      coverage[index] = shape(u, v, unit);
    }
    return { size, distance: signedDistance(size, coverage), tone: new Float32Array(size * size).fill(1) };
  });
}

/**
 * The logo, sampled from the mark's own image so the outline is exact. Lighter parts of the mark get fuller dots
 * than its darker inner folds, so the halftone keeps the logo's depth. Null if the browser can't give a 2D canvas.
 */
export function logoTexture(grid: DotGrid, box: ShapeBox, image: HTMLImageElement): ShapeTexture | null {
  const size = textureSize(grid, box);
  const canvas = document.createElement("canvas");
  canvas.width = size * SUPERSAMPLE;
  canvas.height = size * SUPERSAMPLE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null || image.naturalHeight === 0) {
    return null;
  }
  const height = ((box.half * 2 * RESOLUTION) / grid.pitch) * SUPERSAMPLE;
  const width = (height * image.naturalWidth) / image.naturalHeight;
  context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const coverage = new Float32Array(size * size);
  const tone = new Float32Array(size * size);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let index = 0; index < coverage.length; index += 1) {
    const column = index % size;
    const row = Math.floor(index / size);
    let alphaSum = 0;
    let toneSum = 0;
    for (let dy = 0; dy < SUPERSAMPLE; dy += 1) {
      for (let dx = 0; dx < SUPERSAMPLE; dx += 1) {
        const offset = ((row * SUPERSAMPLE + dy) * canvas.width + column * SUPERSAMPLE + dx) * 4;
        const alpha = (pixels[offset + 3] ?? 0) / 255;
        const luma =
          0.2126 * (pixels[offset] ?? 0) +
          0.7152 * (pixels[offset + 1] ?? 0) +
          0.0722 * (pixels[offset + 2] ?? 0);
        alphaSum += alpha;
        // The mark's dark green folds sit near luma 150 and its light mint faces near 215.
        toneSum += alpha * (0.62 + 0.38 * clamp01((luma - 140) / 80));
      }
    }
    coverage[index] = alphaSum / samples;
    tone[index] = alphaSum > 0 ? toneSum / alphaSum : 1;
  }
  return { size, distance: signedDistance(size, coverage), tone };
}

function bilinear(data: Float32Array, size: number, u: number, v: number, outside: number): number {
  const x = u * RESOLUTION + size / 2 - 0.5;
  const y = v * RESOLUTION + size / 2 - 0.5;
  const column = Math.floor(x);
  const row = Math.floor(y);
  if (column < 0 || row < 0 || column + 1 >= size || row + 1 >= size) {
    return outside;
  }
  const fx = x - column;
  const fy = y - row;
  const at = (c: number, r: number): number => data[r * size + c] ?? outside;
  const top = at(column, row) * (1 - fx) + at(column + 1, row) * fx;
  const bottom = at(column, row + 1) * (1 - fx) + at(column + 1, row + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Signed distance in dot pitches at a point given in dot pitches from the box center. */
export function sampleDistance(texture: ShapeTexture, u: number, v: number): number {
  return bilinear(texture.distance, texture.size, u, v, texture.size / RESOLUTION);
}

/** Dot fullness at a point given in dot pitches from the box center. */
export function sampleTone(texture: ShapeTexture, u: number, v: number): number {
  return bilinear(texture.tone, texture.size, u, v, 1);
}

/** Each dot's distance from the box center, where 1 is the box edge. */
export function dotDistances(grid: DotGrid, box: ShapeBox): Float32Array {
  const field = new Float32Array(grid.columns * grid.rows);
  for (let index = 0; index < field.length; index += 1) {
    const x = (index % grid.columns) * grid.pitch + grid.pitch / 2;
    const y = Math.floor(index / grid.columns) * grid.pitch + grid.pitch / 2;
    field[index] = Math.hypot(x - box.x, y - box.y) / box.half;
  }
  return field;
}
