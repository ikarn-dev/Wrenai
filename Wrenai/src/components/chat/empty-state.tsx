import { ArrowLeftRight, Sprout, Wallet } from "lucide-react";
import type { ReactElement } from "react";
import { JarvisMark } from "./jarvis-mark";

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

// Docs/DESIGN.md → Jarvis → Empty state: the mark, one title, one line on what Jarvis can do, three prompts.
export function ChatEmptyState({ onPrompt }: { readonly onPrompt: (prompt: string) => void }): ReactElement {
  return (
    <div className="mx-auto flex w-full max-w-reading flex-col items-center px-1 pt-6 pb-8 text-center">
      <JarvisMark size={44} />
      <h2 className="mt-5 text-h1">How can I help?</h2>
      <p className="mt-1.5 text-small text-fg-muted">Ask about your wallet, agents, yields and quotes.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {PROMPTS.map(({ icon: Icon, title, prompt }) => (
          <button
            key={title}
            type="button"
            onClick={() => onPrompt(prompt)}
            className="inline-flex h-9 cursor-pointer items-center gap-2 card-shine rounded-full px-3.5 text-small text-fg transition-[color,scale] duration-200 ease-ios hover:text-fg-strong active:scale-97 motion-reduce:active:scale-100 pointer-coarse:h-11"
          >
            <Icon
              size={15}
              strokeWidth={1.75}
              absoluteStrokeWidth
              aria-hidden="true"
              className="text-accent-text"
            />
            {title}
          </button>
        ))}
      </div>
    </div>
  );
}
