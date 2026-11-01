import { Orbit, RotateCcw } from "lucide-react";
import { memo, type ReactElement } from "react";
import type { ChatTurn } from "@/shared/chat";
import { CopyButton } from "./copy-button";
import { ChatMarkdown } from "./markdown";
import { ResearchCards } from "./research-cards";

function utcTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hour12: false,
  }).format(timestamp);
}

interface ChatMessageProps {
  readonly conversationId: string;
  readonly turn: ChatTurn;
  readonly last: boolean;
  readonly busy: boolean;
  readonly onRetry: (turn: ChatTurn) => void;
  readonly pendingReply: {
    readonly content: string;
    readonly status: string;
    readonly checking: boolean;
    readonly onCheck: (() => void) | null;
  } | null;
}

export const ChatMessage = memo(function ChatMessage({
  conversationId,
  turn,
  last,
  busy,
  onRetry,
  pendingReply,
}: ChatMessageProps): ReactElement {
  const reply = turn.reply;
  const pending = turn.state === "pending" ? pendingReply : null;
  return (
    <article className="space-y-6" aria-label={`Message ${turn.sequence}`}>
      <div className="ml-auto max-w-reading pl-8 sm:pl-16">
        <div className="ml-auto w-fit max-w-full whitespace-pre-wrap break-words rounded-lg bg-surface-2 px-4 py-3 text-body leading-relaxed text-fg-strong">
          {turn.message}
        </div>
        <div className="flex items-center justify-end gap-2">
          <CopyButton text={turn.message} />
        </div>
      </div>
      {reply || pending ? (
        <div className="flex min-w-0 gap-3 sm:gap-4">
          <Orbit size={20} strokeWidth={1.5} aria-hidden="true" className="mt-1 shrink-0 text-accent-text" />
          <div className="min-w-0 flex-1">
            <ChatMarkdown content={reply?.content ?? pending?.content ?? ""} />
            <div className="mt-2 flex min-h-11 flex-wrap items-start gap-3">
              {reply ? (
                <>
                  <CopyButton text={reply.content} />
                  <details className="min-w-0 py-3 text-caption text-fg-subtle">
                    <summary className="cursor-pointer rounded-xs">Model response verified</summary>
                    {reply.context ? (
                      <p className="mt-4 border-l border-line pl-3 text-caption text-fg-subtle">
                        Account snapshot · NEAR RPC & Wrenai · {utcTime(reply.context.readAt)} UTC. Native
                        wallet balance and agent status only.
                      </p>
                    ) : null}
                    <dl className="mt-3 grid gap-2 break-words text-caption">
                      <div>
                        <dt className="text-fg-muted">Model</dt>
                        <dd>{reply.receipt.model}</dd>
                      </div>
                      <div>
                        <dt className="text-fg-muted">Verified at</dt>
                        <dd>{new Date(reply.receipt.verifiedAt).toISOString()}</dd>
                      </div>
                      <div>
                        <dt className="text-fg-muted">Response ID</dt>
                        <dd className="break-all font-mono">{reply.receipt.completionId}</dd>
                      </div>
                      <div>
                        <dt className="text-fg-muted">Evidence hash</dt>
                        <dd className="break-all font-mono">{reply.receipt.evidenceHash}</dd>
                      </div>
                    </dl>
                    <p className="mt-3 max-w-reading">
                      Wrenai verified this response’s signature. Deployment evidence may be reused for up to
                      60 seconds. This does not verify the answer’s factual accuracy.
                    </p>
                  </details>
                </>
              ) : pending ? (
                <div
                  role="status"
                  className="flex min-h-11 flex-wrap items-center gap-3 text-caption text-fg-subtle"
                >
                  <span>{pending.status}</span>
                  {pending.onCheck ? (
                    <button
                      type="button"
                      disabled={pending.checking}
                      onClick={pending.onCheck}
                      className="min-h-11 cursor-pointer rounded-sm px-3 text-accent-text hover:bg-surface-2 disabled:cursor-progress"
                    >
                      {pending.checking ? "Checking…" : "Check response"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {reply?.research?.length ? (
              <ResearchCards reports={reply.research} source={{ conversationId, turnId: turn.id }} />
            ) : null}
            {reply?.historyTrimmed ? (
              <p className="mt-3 text-caption text-fg-subtle">
                This reply used the most recent messages that fit the context limit.
              </p>
            ) : null}
          </div>
        </div>
      ) : turn.state === "failed" || turn.state === "cancelled" ? (
        <div className="flex flex-wrap items-center gap-3 text-small text-fg-subtle">
          <span>{turn.state === "cancelled" ? "Reply stopped." : "A reply wasn’t completed."}</span>
          {last ? (
            <button
              type="button"
              onClick={() => onRetry(turn)}
              disabled={busy}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-3 text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-strong disabled:cursor-not-allowed disabled:text-fg-disabled"
            >
              <RotateCcw size={14} aria-hidden="true" />
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});
