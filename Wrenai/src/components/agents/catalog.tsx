import { MessageCircle, Plus } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { PortfolioSection } from "@/components/portfolio/panel";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import { activeAgentToolSchema } from "@/shared/agent-scope";
import { AgentAvatar } from "./avatar";
import { CreateAgentLink } from "./create-agent-link";

const ICON = { "aria-hidden": true, size: 14, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

/** Every agent type as a card: the mark and name, one description, then two actions. */
export function AgentCatalog({
  tools = activeAgentToolSchema.options,
  testnet = false,
}: {
  readonly tools?: readonly (typeof activeAgentToolSchema.options)[number][];
  readonly testnet?: boolean;
}): ReactElement {
  return (
    <PortfolioSection
      id="agent-types"
      title="Choose an agent"
      aside={<span className="text-caption text-fg-subtle">Review a strategy before it runs</span>}
    >
      <div className="grid min-w-0 auto-rows-fr gap-stack md:grid-cols-2 2xl:grid-cols-3">
        {tools.map((tool) => {
          const item = AGENT_CATALOG[tool];
          return (
            <article key={tool} className="flex min-w-0 flex-col gap-3 card-shine rounded-lg p-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <AgentAvatar size={20} />
                <h3 className="truncate text-body font-medium text-fg-strong">
                  {testnet && tool === "private_payments" ? "Payments Agent" : item.name}
                </h3>
              </div>
              <p className="flex-1 text-small text-fg-muted">
                {testnet && tool === "private_payments"
                  ? "Send test tokens to a wallet or public Intents balance."
                  : testnet && tool === "spot_trader"
                    ? "Make one test-token buy or sell within an allocated budget."
                    : testnet && tool === "sell_the_top"
                      ? "Sell once when proceeds reach a target above your acquisition cost."
                      : item.description}
              </p>
              {/* Two equal actions: Create opens the dialog over this page; Ask Jarvis researches the type first. */}
              <div className="grid grid-cols-2 gap-2">
                <CreateAgentLink
                  href={testnet ? `/testnet/agents?create=${tool}` : `/agents?create=${tool}`}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-sm bg-surface-3 text-small font-medium text-fg-strong ring-1 ring-line-strong/40 ring-inset transition-[background-color,scale] duration-200 ease-ios hover:bg-surface-4 active:scale-97 motion-reduce:active:scale-100 pointer-coarse:h-11"
                >
                  <Plus {...ICON} className="text-accent-text" />
                  Create
                </CreateAgentLink>
                <Link
                  href={testnet ? `/testnet/chat?tool=${tool}` : `/chat?tool=${tool}`}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-sm text-small text-fg-muted ring-1 ring-line-card ring-inset transition-[background-color,color,scale] duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong active:scale-97 motion-reduce:active:scale-100 pointer-coarse:h-11"
                >
                  <MessageCircle {...ICON} />
                  Ask Jarvis
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    </PortfolioSection>
  );
}
