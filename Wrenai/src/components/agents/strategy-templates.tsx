import { ChevronDown } from "lucide-react";
import type { AgentStrategyTemplate } from "@/shared/agent-templates";

export function StrategyTemplates({
  templates,
  hasInstructions,
  onApply,
}: {
  readonly templates: readonly AgentStrategyTemplate[];
  readonly hasInstructions: boolean;
  readonly onApply: (text: string) => void;
}) {
  if (templates.length === 0) {
    return null;
  }
  return (
    <details className="group rounded-sm border border-line">
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 rounded-sm px-3 text-small text-fg pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
        Strategy templates
        <ChevronDown
          aria-hidden="true"
          size={16}
          className="shrink-0 text-fg-muted motion-safe:transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t border-line">
        {hasInstructions ? (
          <p className="px-3 pt-2 text-caption text-fg-muted">
            Applying a template replaces your instructions.
          </p>
        ) : null}
        <ul className="divide-y divide-line">
          {templates.map((template) => (
            <li key={template.name}>
              <button
                type="button"
                onClick={() => onApply(template.text)}
                className="flex min-h-11 w-full cursor-pointer flex-col items-start gap-1 px-3 py-2.5 text-left text-small transition-colors hover:bg-surface-3"
              >
                <span className="font-medium text-fg-strong">{template.name}</span>
                <span className="text-caption text-fg-muted">{template.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
