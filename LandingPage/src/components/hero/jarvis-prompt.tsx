import { ArrowUp } from "lucide-react";
import type { ReactElement } from "react";
import { appHref } from "@/app-url";
import { JarvisDemo } from "./jarvis-demo";

/**
 * Jarvis's composer, as the app shows it: example questions typing in, the tool chips selecting themselves to
 * match, and Ask. Nothing takes input except Ask, which opens Jarvis in the app scoped to the selected tool. A
 * plain GET form, so it still works before and without JavaScript (with the first example's tool).
 */
export function JarvisPrompt(): ReactElement {
  return (
    // The wrapper is the size container: everything in the card scales from its width (hero.css → jarvis-*).
    <div className="@container w-full max-w-reading">
      <form
        action={appHref("/chat")}
        method="get"
        target="_blank"
        className="jarvis-card w-full text-left"
        rel="noopener"
      >
        <p className="jarvis-label flex items-center text-ink">
          <span aria-hidden="true" className="jarvis-mark" />
          Jarvis
        </p>
        {/* The typed examples and chips are display only; this is what they say. */}
        <p className="sr-only">Ask Jarvis about NEAR markets, yields or a strategy.</p>
        <JarvisDemo>
          <button
            type="submit"
            className="button-shine jarvis-ask relative inline-flex cursor-pointer items-center rounded-full text-fg focus-visible:outline-ink-focus active:scale-97 motion-reduce:active:scale-100"
          >
            Ask Jarvis
            <ArrowUp aria-hidden="true" size={18} strokeWidth={1.75} absoluteStrokeWidth />
          </button>
        </JarvisDemo>
      </form>
    </div>
  );
}
