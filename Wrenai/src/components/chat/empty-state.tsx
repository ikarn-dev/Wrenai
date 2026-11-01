import { ArrowLeftRight, Sprout, Wallet } from "lucide-react";
import type { ReactElement } from "react";

const PROMPTS = [
  {
    icon: ArrowLeftRight,
    title: "Find arbitrage",
    prompt:
      "Find current NEAR arbitrage candidates. Check live quotes and distinguish indicative gaps from confirmed opportunities.",
  },
  {
    icon: Sprout,
    title: "Explore yields",
    prompt:
      "Compare current NEAR yield opportunities using live data, including costs and withdrawal requirements.",
  },
  {
    icon: Wallet,
    title: "Review my wallet",
    prompt:
      "Summarize my available wallet balance and agent status. Be clear about any missing portfolio data.",
  },
] as const;

export function ChatEmptyState({ onPrompt }: { readonly onPrompt: (prompt: string) => void }): ReactElement {
  return (
    <div className="mx-auto flex w-full max-w-reading flex-col items-center gap-6 px-1 pt-6 pb-5 sm:gap-8 sm:pb-6">
      <h2 className="text-center text-h1 font-medium text-fg-strong">How can I help?</h2>
      <div className="flex flex-wrap justify-center gap-2">
        {PROMPTS.map(({ icon: Icon, title, prompt }) => (
          <button
            key={title}
            type="button"
            onClick={() => onPrompt(prompt)}
            className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-line-subtle px-4 text-small text-fg-muted transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-fg-strong"
          >
            <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
            {title}
          </button>
        ))}
      </div>
    </div>
  );
}
