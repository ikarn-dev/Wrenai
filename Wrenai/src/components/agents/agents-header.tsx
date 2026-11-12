import { Plus } from "lucide-react";
import type { ReactElement } from "react";
import { AgentsInfo } from "@/components/agents/agents-info";
import { CreateAgentLink } from "@/components/agents/create-agent-link";
import { RefreshPortfolioButton } from "@/components/portfolio/refresh-button";
import { ANY_AGENT_TYPE } from "@/shared/agent-create-request";

/** The live count's placeholder: the badge's own 24 px height, so the "Your agents" row never changes height. */
export const LIVE_COUNT_PLACEHOLDER = (
  <span aria-hidden="true" className="block h-6 w-36 rounded-full bg-surface-2 motion-safe:animate-pulse" />
);

/** The Agents page title and actions. Needs no data, so the loading screen renders the same header. */
export function AgentsHeader({ testnet = false }: { readonly testnet?: boolean }): ReactElement {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <h1 className="font-display text-page-title">Agents</h1>
      <div className="flex items-center gap-3">
        <AgentsInfo />
        <RefreshPortfolioButton />
        <CreateAgentLink
          href={testnet ? `/testnet/agents?create=${ANY_AGENT_TYPE}` : `/agents?create=${ANY_AGENT_TYPE}`}
          className="inline-flex h-9 items-center gap-1.5 rounded-sm bg-accent px-3.5 text-small font-medium text-accent-fg transition-[background-color,scale] duration-200 ease-ios hover:bg-accent-text active:scale-97 motion-reduce:active:scale-100 pointer-coarse:h-11"
        >
          <Plus size={15} strokeWidth={2} absoluteStrokeWidth aria-hidden="true" />
          New agent
        </CreateAgentLink>
      </div>
    </header>
  );
}

/** The "No agents yet" card. The loading screen draws the same box, so the page doesn't shift. */
export const EMPTY_AGENTS_CARD =
  "relative flex flex-col items-center gap-3 overflow-hidden card-shine rounded-lg px-6 py-10 text-center";
