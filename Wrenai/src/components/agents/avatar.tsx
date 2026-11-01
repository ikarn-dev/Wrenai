import { Atom, Compass, Crosshair, Fingerprint, Hexagon, Radar, Target, Waypoints } from "lucide-react";
import type { ReactElement } from "react";

const ICONS = [Radar, Compass, Crosshair, Waypoints, Atom, Hexagon, Fingerprint, Target] as const;
export function AgentAvatar({
  id,
  running = false,
}: {
  readonly id: string;
  readonly running?: boolean;
}): ReactElement {
  let hash = 2166136261;
  for (const character of id) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  const Icon = ICONS[(hash >>> 0) % ICONS.length] ?? Radar;
  return (
    <Icon
      aria-hidden="true"
      size={24}
      strokeWidth={1.75}
      absoluteStrokeWidth
      className={`shrink-0 ${running ? "text-accent-text" : "text-fg-muted"}`}
    />
  );
}
