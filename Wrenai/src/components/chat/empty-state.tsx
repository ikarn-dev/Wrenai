import { CalendarClock, ChartNoAxesCombined, Wallet } from "lucide-react";
import type { ReactElement } from "react";
import { JarvisMark } from "./jarvis-mark";

const PROMPTS = [
  {
    icon: ChartNoAxesCombined,
    title: "Analyze a market",
    prompt:
      "Analyze BTC perpetuals using current price action, chart indicators, funding and recent news. Give a clear bias and explain entry, take-profit, stop-loss and invalidation.",
  },
  {
    icon: CalendarClock,
    title: "Plan recurring buys",
    prompt:
      "Help me plan recurring NEAR purchases. Ask for my spending token, amount and schedule before proposing an agent.",
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
      <p className="mt-1.5 text-small text-fg-muted">Ask about markets, your wallet or your agents.</p>
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
