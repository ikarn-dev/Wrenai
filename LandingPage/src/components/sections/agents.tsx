import type { ReactElement } from "react";
import { appHref } from "@/app-url";
import { AGENTS } from "@/components/agents/agent-data";
import { AgentSlides } from "@/components/agents/agent-slides";
import { FramedSection } from "./section-frame";

/** Every active agent, one slide each: a split header, then the list and its example setup. */
export function Agents(): ReactElement {
  // Links are built here, on the server, so client code never reads the app's address from the environment.
  const agents = AGENTS.map((agent) => ({ ...agent, href: appHref(`/agents?create=${agent.pack}`) }));
  return (
    <FramedSection id="agents" labelledBy="agents-title" tight>
      {/* The Features header pattern: the title on one line over three fifths, the line beside it on the right edge,
          both on one baseline. The title wraps only below lg, where the column is narrow. */}
      <header className="grid gap-4 lg:grid-cols-5 lg:items-end lg:gap-10">
        <h2 id="agents-title" data-reveal="rise" className="text-section lg:col-span-3 lg:whitespace-nowrap">
          Seven agents, one <span className="text-accent-text">job</span> each
        </h2>
        <p
          data-reveal="fade"
          data-reveal-delay="0.2"
          className="section-lede max-w-sm text-fg-muted lg:col-span-2 lg:justify-self-end"
        >
          Each runs one strategy with its own budget, inside limits only you can change.
        </p>
      </header>
      <div data-reveal="fade" data-reveal-delay="0.1" className="mt-head">
        <AgentSlides agents={agents} />
      </div>
    </FramedSection>
  );
}
