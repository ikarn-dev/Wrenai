import type { CSSProperties, ReactElement } from "react";
import { seededRandom } from "@/components/texture/seeded-random";

// Flat box patches on the footer's background grid (user reference, Nov 2026): faint mint and grey washes that
// lift a cell a few percent above the ground, one slightly stronger mint cell as the accent (footer.css). Each
// patch fills whole cells of the 72 px grid, which is anchored at the bottom center, so patches and grid lines
// meet. They stay in the lowest rows, behind the wordmark, and never under the links. Fixed seed: the same
// patches on every render. Decoration only.

const CELL = 72;
const COUNT = 14;
/** Cells either side of center, and rows up from the bottom. */
const REACH = 10;
const ROWS = 4;
const TONES = ["soft", "soft", "mint", "grey"] as const;

type Tone = (typeof TONES)[number] | "accent";

interface Patch {
  readonly id: string;
  readonly column: number;
  readonly row: number;
  readonly wide: number;
  readonly tone: Tone;
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
    placed.push({ id: cells[0] ?? `${placed.length.toString()}`, column, row, wide, tone });
  }
  return placed;
}

const PATCHES = patches();

/** The patches layer; the footer sets its mask and stacking. */
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
        return <span key={patch.id} data-tone={patch.tone} className="footer-patch" style={style} />;
      })}
    </div>
  );
}
