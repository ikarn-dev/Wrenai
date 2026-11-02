import { ArrowRight, BookOpen } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { PortfolioSection } from "@/components/portfolio/panel";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import { activeAgentToolSchema } from "@/shared/agent-scope";
import { AgentAvatar } from "./avatar";

const ICON = { "aria-hidden": true, size: 14, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

/** Every agent type as a card: the mark and name, one description, then two actions. */
export function AgentCatalog(): ReactElement {
  return (
    <PortfolioSection
      id="agent-types"
      title="Choose an agent"
      aside={<span className="text-caption text-fg-subtle">Review a strategy before it runs</span>}
    >
      <div className="grid min-w-0 auto-rows-fr gap-stack md:grid-cols-2 2xl:grid-cols-3">
        {activeAgentToolSchema.options.map((tool) => {
          const item = AGENT_CATALOG[tool];
          return (
            <article key={tool} className="flex min-w-0 flex-col gap-3 card-shine rounded-lg p-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <AgentAvatar size={20} />
                <h3 className="truncate text-body font-medium text-fg-strong">{item.name}</h3>
              </div>
              <p className="flex-1 text-small text-fg-muted">{item.description}</p>
              <div className="flex items-center justify-between gap-2">
                {/* The card's main action sits on a subtle raised fill; Research stays a quiet text link. */}
                <Link
                  href={`/agents/new?tool=${tool}`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-surface-3 px-3 text-small font-medium text-accent-text ring-1 ring-line-strong/40 ring-inset transition-[background-color,scale] duration-200 ease-ios hover:bg-surface-4 active:scale-97 motion-reduce:active:scale-100 pointer-coarse:h-11"
                >
                  Create setup
                  <ArrowRight {...ICON} />
                </Link>
                <Link
                  href={`/chat?tool=${tool}`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-sm px-2 text-small text-fg-muted transition-colors duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong pointer-coarse:h-11"
                >
                  <BookOpen {...ICON} />
                  Research
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    </PortfolioSection>
  );
}
