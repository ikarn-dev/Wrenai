/**
 * A tiny deterministic generator (Park–Miller), so decorative layouts drawn from it (the privacy stars, the
 * footer's patches) render identically on the server and on every visit. Returns numbers in [0, 1).
 */
export function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return state / 2_147_483_647;
  };
}
