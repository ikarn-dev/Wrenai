import type { CSSProperties, ReactElement } from "react";
import { seededRandom } from "@/components/texture/seeded-random";

// A few points of the section's dot grid twinkle like stars (user request, Nov 2026). Each sits exactly on a grid
// dot: the dot grid's 16 px tiles are anchored at the top center, so its dots fall at 50% + 16k px across and
// 8 + 16m px down. Positions come from a fixed seed, so the server renders the same sky every time; the title's
// band is kept clear (DESIGN.md → textures never under text). CSS opacity and scale only (privacy.css → star).

const CELL = 16;
const COUNT = 30;
/** Cells either side of center, and rows down the grid's 384 px band. */
const REACH = 34;
const ROWS = 23;
/** The title's band, in cells: rows 2–6 within 15 cells of center. */
const TITLE = { rows: [2, 6], reach: 15 } as const;

interface Star {
  readonly id: string;
  readonly column: number;
  readonly row: number;
  readonly mint: boolean;
  /** Seconds. */
  readonly delay: number;
  readonly duration: number;
}

function sky(): readonly Star[] {
  const next = seededRandom(48_271);
  const stars = new Map<string, Star>();
  while (stars.size < COUNT) {
    const column = Math.round((next() * 2 - 1) * REACH);
    const row = 1 + Math.floor(next() * ROWS);
    const underTitle = row >= TITLE.rows[0] && row <= TITLE.rows[1] && Math.abs(column) <= TITLE.reach;
    const id = `${column}:${row}`;
    if (underTitle || stars.has(id)) {
      continue;
    }
    stars.set(id, {
      id,
      column,
      row,
      mint: next() < 0.3,
      delay: Math.round(next() * 60) / 10,
      duration: 3 + Math.round(next() * 30) / 10,
    });
  }
  return [...stars.values()];
}

const STARS = sky();

/** The twinkling points, over the dot grid at the top of a framed section. Decoration only. */
export function StarField(): ReactElement {
  return (
    <div aria-hidden="true" className="star-field pointer-events-none absolute inset-x-0 top-0 -z-10 h-96">
      {STARS.map((star) => {
        const style: CSSProperties & Record<`--${string}`, string> = {
          left: `calc(50% + ${(star.column * CELL).toString()}px)`,
          top: `${(CELL / 2 + star.row * CELL).toString()}px`,
          "--delay": `${star.delay.toString()}s`,
          "--duration": `${star.duration.toString()}s`,
        };
        return (
          <span key={star.id} data-tone={star.mint ? "mint" : undefined} className="star" style={style} />
        );
      })}
    </div>
  );
}
