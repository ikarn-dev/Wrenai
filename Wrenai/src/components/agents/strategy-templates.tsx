import type { AgentStrategyTemplate } from "@/shared/agent-templates";

/**
 * Templates as one row of small chips above the instructions. Applying one fills the text in place, so the form
 * never grows or shifts the way an expanding list did. Each chip's hint is its tooltip.
 */
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
    <fieldset className="flex min-w-0 flex-wrap items-center gap-1.5">
      <legend className="sr-only">Strategy templates</legend>
      <span aria-hidden="true" className="mr-0.5 text-caption text-fg-subtle">
        Templates
      </span>
      {templates.map((template) => (
        <button
          key={template.name}
          type="button"
          title={hasInstructions ? `${template.hint} Replaces your instructions.` : template.hint}
          onClick={() => onApply(template.text)}
          className="inline-flex h-7 max-w-full cursor-pointer items-center truncate rounded-full bg-surface-3 px-2.5 text-caption font-medium text-fg transition-colors duration-200 ease-ios hover:bg-surface-4 hover:text-fg-strong pointer-coarse:h-9"
        >
          {template.name}
        </button>
      ))}
    </fieldset>
  );
}
