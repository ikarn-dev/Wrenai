import { ArrowUp } from "lucide-react";
import type { ReactElement } from "react";
import { appHref } from "@/app-url";

// Four of the app's active research tools (Docs/DESIGN.md, November 2 scope). The values are the app's tool IDs:
// /chat?tool=… opens Jarvis scoped to that tool.
const TOOLS = [
  { id: "spot_trader", label: "Spot Trader" },
  { id: "dca", label: "DCA" },
  { id: "perps", label: "Perps" },
  { id: "meme_hunter", label: "Meme Hunter" },
] as const;

/**
 * Jarvis's composer, as the app shows it: a question box, research tools and Ask. A plain GET form with native
 * radio chips, so it works before and without JavaScript and ships no client code. Submitting opens Jarvis in the
 * app with the chosen tool; no tool means Auto.
 */
export function JarvisPrompt(): ReactElement {
  return (
    <form
      action={appHref("/chat")}
      method="get"
      className="jarvis-card flex w-full max-w-reading flex-col gap-4 rounded-xl p-card text-left"
    >
      <label htmlFor="jarvis-question" className="flex items-center gap-2 text-small font-medium text-ink">
        <span aria-hidden="true" className="jarvis-mark size-5 shrink-0" />
        Jarvis
      </label>
      {/* Unnamed: the app's chat doesn't read a question from the URL, so it isn't sent. */}
      <textarea
        id="jarvis-question"
        rows={3}
        maxLength={8000}
        placeholder="Ask about NEAR markets, yields or a strategy"
        className="min-h-24 w-full resize-none bg-transparent text-body text-ink outline-none placeholder:text-ink-subtle"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">Research tool</legend>
          {TOOLS.map((tool) => (
            <label
              key={tool.id}
              className="inline-flex h-9 cursor-pointer items-center rounded-full bg-chip px-3.5 text-small font-medium text-ink-muted ring-1 ring-chip-line ring-inset transition-colors duration-300 ease-ios select-none hover:text-ink has-checked:bg-chip-selected has-checked:text-ink has-checked:ring-ink-focus has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ink-focus pointer-coarse:h-11"
            >
              <input type="radio" name="tool" value={tool.id} className="sr-only" />
              {tool.label}
            </label>
          ))}
        </fieldset>
        <button
          type="submit"
          className="ml-auto inline-flex h-11 cursor-pointer items-center gap-2 rounded-full bg-ink-button pr-4 pl-5 text-body font-medium text-fg-strong transition-[background-color,scale] duration-300 ease-ios hover:bg-ink-button-hover focus-visible:outline-ink-focus active:scale-97 motion-reduce:active:scale-100"
        >
          Ask Jarvis
          <ArrowUp aria-hidden="true" size={18} strokeWidth={1.75} absoluteStrokeWidth />
        </button>
      </div>
    </form>
  );
}
