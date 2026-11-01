import { ArrowRight, BookOpen } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import { packSchema } from "@/shared/agents";

export function AgentCatalog(): ReactElement {
  return (
    <section aria-label="Agent types" className="space-y-4">
      <div>
        <h2 className="text-h2">Choose an agent</h2>
        <p className="mt-2 text-small text-fg-muted">
          Review a strategy before authorizing and activating it.
        </p>
      </div>
      <div className="grid min-w-0 auto-rows-fr gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {Object.entries(AGENT_CATALOG).map(([tool, item]) => (
          <article
            key={tool}
            className="flex min-w-0 flex-col gap-3 rounded-md border border-line-subtle bg-surface-1 p-5"
          >
            <h3 className="text-h3 font-medium">{item.name}</h3>
            <p className="text-caption text-fg-subtle">
              {packSchema.safeParse(tool).success
                ? "Execution adapter available · setup required"
                : "Research and setup only"}
            </p>
            <p className="flex-1 text-small leading-relaxed text-fg-muted">{item.description}</p>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-subtle pt-2">
              <Link
                href={`/agents/new?tool=${tool}`}
                className="inline-flex min-h-11 items-center gap-2 rounded-sm px-2 text-small text-accent-text hover:bg-surface-2"
              >
                Create setup
                <ArrowRight size={15} aria-hidden="true" />
              </Link>
              <Link
                href={`/chat?tool=${tool}`}
                className="inline-flex min-h-11 items-center gap-2 rounded-sm px-2 text-small text-fg-muted hover:bg-surface-2"
              >
                <BookOpen size={15} aria-hidden="true" />
                Research
              </Link>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
