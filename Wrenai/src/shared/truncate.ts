/** Shortens a long identifier in the middle (`3f9a…c21e`). Show the full value in a tooltip next to it. */
export function middleTruncate(value: string, head: number, tail: number): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}
