"use client";

import { ArrowDown, ArrowUpRight, X } from "lucide-react";
import { AnimatePresence, m, type Transition } from "motion/react";
import { type ReactElement, type RefObject, useState } from "react";
import { usePrefersReducedMotion } from "@/components/motion/use-prefers-reduced-motion";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import { createRequestPack } from "@/shared/agent-create-request";
import { isActiveAgentTool } from "@/shared/agent-scope";
import type { AgentSummary } from "@/shared/agents";
import type { ChatTurn } from "@/shared/chat";
import type { ResearchTool } from "@/shared/research";

export interface AgentOffer {
  readonly conversationId: string;
  readonly turnId: string;
  readonly tool: ResearchTool;
  readonly key: string;
}

export function latestAgentOffer(conversationId: string, turn: ChatTurn | undefined): AgentOffer | null {
  if (turn?.state !== "complete" || !turn.reply || turn.reply.manual) {
    return null;
  }
  const eligible =
    turn.reply.research?.filter(
      (report) => isActiveAgentTool(report.tool) && report.status !== "unavailable",
    ) ?? [];
  const report = turn.tool ? eligible.findLast((item) => item.tool === turn.tool) : eligible.at(-1);
  return report
    ? {
        conversationId,
        turnId: turn.id,
        tool: report.tool,
        key: `${conversationId}:${turn.id}:${report.tool}`,
      }
    : null;
}

const ENTER: Transition = { type: "spring", stiffness: 350, damping: 32 };
const FADE: Transition = { duration: 0.18, ease: [0.32, 0.72, 0, 1] };
const EXIT_DURATION = 0.16;

interface AgentOfferPromptProps {
  readonly offer: AgentOffer | null;
  readonly visible: boolean;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly jumpToLatest: (() => void) | null;
  readonly onCreate: (pack: AgentSummary["pack"]) => void;
}

export function AgentOfferPrompt({
  offer,
  visible,
  inputRef,
  jumpToLatest,
  onCreate,
}: AgentOfferPromptProps): ReactElement {
  const reducedMotion = usePrefersReducedMotion();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const key = offer?.key ?? null;

  function dismiss(): void {
    if (key) {
      setDismissed((items) => new Set([...items, key]));
    }
    inputRef.current?.focus({ preventScroll: true });
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 mb-3 flex flex-col items-center gap-3 px-1">
      {jumpToLatest ? (
        <button
          type="button"
          aria-label="Jump to latest message"
          onClick={jumpToLatest}
          className="pointer-events-auto inline-flex size-9 cursor-pointer items-center justify-center card-shine rounded-full text-fg-muted transition-colors duration-200 ease-ios hover:text-fg-strong pointer-coarse:size-11"
        >
          <ArrowDown size={18} aria-hidden="true" />
        </button>
      ) : null}
      <AnimatePresence initial={false} mode="wait">
        {offer && visible && !dismissed.has(offer.key) ? (
          <m.fieldset
            key={offer.key}
            initial={{
              opacity: reducedMotion ? 1 : 0,
              y: reducedMotion ? 0 : 12,
              scale: reducedMotion ? 1 : 0.98,
            }}
            animate={{ opacity: 1, y: 0, scale: 1, pointerEvents: "auto" }}
            exit={{
              opacity: 0,
              y: reducedMotion ? 0 : 6,
              pointerEvents: "none",
              transition: { duration: reducedMotion ? 0 : EXIT_DURATION },
            }}
            transition={reducedMotion ? { duration: 0 } : { ...ENTER, opacity: FADE }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                dismiss();
              }
            }}
            className="pointer-events-auto min-w-0 max-w-full rounded-lg card-shine p-1.5 shadow-float"
          >
            <legend className="sr-only">Agent suggestion</legend>
            <div className="flex items-center gap-1">
              {/* Opens the create dialog for this type; nothing is saved until the user deploys it there. */}
              <button
                type="button"
                onClick={() => {
                  const pack = createRequestPack(offer.tool);
                  if (pack) {
                    onCreate(pack);
                  }
                }}
                className="inline-flex min-h-10 min-w-0 items-center gap-2 rounded-sm px-3 text-small font-medium text-fg-strong transition-colors duration-200 ease-ios hover:bg-surface-2 pointer-coarse:min-h-11"
              >
                <ArrowUpRight size={16} aria-hidden="true" className="shrink-0 text-accent-text" />
                <span className="truncate">{`Create ${AGENT_CATALOG[offer.tool].name}`}</span>
              </button>
              <button
                type="button"
                onClick={dismiss}
                aria-label="Dismiss agent suggestion"
                className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg-subtle transition-colors duration-200 ease-ios hover:bg-surface-2 hover:text-fg-strong pointer-coarse:size-11"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>
          </m.fieldset>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
