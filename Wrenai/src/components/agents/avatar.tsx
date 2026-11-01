import type { ReactElement } from "react";
import { JarvisMark } from "@/components/chat/jarvis-mark";

/**
 * An agent's avatar: the app's logo mark, bare (Docs/DESIGN.md → Agents → Avatars). While the agent runs, its outer
 * ring turns slowly around the still eye, the same motion as Jarvis at work; otherwise it rests.
 */
export function AgentAvatar({
  running = false,
  size = 24,
}: {
  readonly running?: boolean;
  readonly size?: number;
}): ReactElement {
  return (
    <span {...(running ? { "data-jarvis-working": true } : {})} className="jarvis-row inline-flex shrink-0">
      <JarvisMark size={size} layered />
    </span>
  );
}
