import type { CSSProperties, ReactElement } from "react";
import { seededRandom } from "@/components/texture/seeded-random";

// Flat box patches on the footer's background grid (user reference, Nov 2026): faint mint and grey washes that
// lift a cell a few percent above the ground, one slightly stronger mint cell as the accent (footer-patches.css).
// Each patch fills whole cells of the 72 px grid, whose lines sit at the center ± multiples of 72 px and the bottom
// + multiples of 72 px, so patch edges and grid lines meet. They stay in the lowest rows, behind the wordmark, and
// never under the links. Beams run on those same lines (user request, Nov 2026), horizontally and vertically: some
// patches send one along their bottom or left edge, and a few cross the whole grid. They sit behind the wordmark,
// whose letters are opaque, so a beam never shows over the text. Fixed seed: the same layout on every render.
// Decoration only; motion is CSS on transform and opacity, and reduced motion leaves the still patches.

const CELL = 72;
const COUNT = 14;
/** Cells either side of center, and rows up from the bottom. */
const REACH = 10;
const ROWS = 4;
const TONES = ["soft", "soft", "mint", "grey"] as const;

type Tone = (typeof TONES)[number] | "accent";
/** A patch's bottom and left edges lie on grid lines inside its own box, so its beam runs on one of them. */
type Edge = "bottom" | "left";

interface Beam {
  readonly duration: number;
  readonly delay: number;
}

interface Patch {
  readonly id: string;
  readonly column: number;
  readonly row: number;
  readonly wide: number;
  readonly tone: Tone;
  readonly beam: (Beam & { readonly edge: Edge }) | null;
}

function patches(): readonly Patch[] {
  const next = seededRandom(91_331);
  const taken = new Set<string>();
  const placed: Patch[] = [];
  while (placed.length < COUNT) {
    const column = Math.floor((next() * 2 - 1) * REACH);
    // Lower rows fill more often, so the patches gather toward the bottom like the light.
    const row = Math.floor(next() ** 1.6 * ROWS);
    const wide = next() < 0.25 ? 2 : 1;
    const cells = Array.from(
      { length: wide },
      (_, offset) => `${(column + offset).toString()}:${row.toString()}`,
    );
    if (cells.some((cell) => taken.has(cell))) {
      continue;
    }
    for (const cell of cells) {
      taken.add(cell);
    }
    const tone: Tone = placed.length === 5 ? "accent" : (TONES[Math.floor(next() * TONES.length)] ?? "soft");
    const beam =
      next() < 0.45
        ? {
            edge: next() < 0.5 ? ("bottom" as const) : ("left" as const),
            duration: 6 + next() * 5,
            delay: next() * 8,
          }
        : null;
    placed.push({ id: cells[0] ?? `${placed.length.toString()}`, column, row, wide, tone, beam });
  }
  return placed;
}

const PATCHES = patches();
// Beams across the whole grid: along a row line (cells up from the bottom) or up a column line (cells from center).
const ROW_SCANS: readonly (Beam & { readonly row: number })[] = [
  { row: 1, duration: 13, delay: 0 },
  { row: 2, duration: 17, delay: 6 },
];
const COLUMN_SCANS: readonly (Beam & { readonly column: number })[] = [
  { column: -7, duration: 9, delay: 2 },
  { column: -2, duration: 11, delay: 7 },
  { column: 3, duration: 10, delay: 4 },
  { column: 8, duration: 12, delay: 9 },
];

type Style = CSSProperties & Record<`--${string}`, string>;

/** A beam's loop length and start offset, read by its CSS animation. */
function timing(beam: Beam): Style {
  return { "--duration": `${beam.duration.toFixed(2)}s`, "--delay": `${beam.delay.toFixed(2)}s` };
}

/** The patches layer; the footer sets its stacking. */
export function FooterPatches(): ReactElement {
  return (
    <div aria-hidden="true" className="footer-grid pointer-events-none absolute inset-0">
      {PATCHES.map((patch) => {
        const style: CSSProperties = {
          left: `calc(50% + ${(patch.column * CELL).toString()}px)`,
          bottom: `${(patch.row * CELL).toString()}px`,
          width: `${(patch.wide * CELL).toString()}px`,
          height: `${CELL.toString()}px`,
        };
        return (
          <span key={patch.id} data-tone={patch.tone} className="footer-patch" style={style}>
            {patch.beam ? (
              <span data-edge={patch.beam.edge} className="footer-patch-beam" style={timing(patch.beam)} />
            ) : null}
          </span>
        );
      })}
      {ROW_SCANS.map((scan) => (
        <span
          key={`row-${scan.row.toString()}`}
          data-axis="row"
          className="footer-scan"
          style={{ bottom: `${(scan.row * CELL).toString()}px`, ...timing(scan) }}
        />
      ))}
      {COLUMN_SCANS.map((scan) => (
        <span
          key={`column-${scan.column.toString()}`}
          data-axis="column"
          className="footer-scan"
          style={{ left: `calc(50% + ${(scan.column * CELL).toString()}px)`, ...timing(scan) }}
        />
      ))}
    </div>
  );
}
