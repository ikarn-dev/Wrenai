import { RotateCcw, ShieldCheck } from "lucide-react";
import { memo, type ReactElement, type ReactNode } from "react";
import type { ChatReply, ChatTurn } from "@/shared/chat";
import { CopyButton } from "./copy-button";
import { JarvisMark } from "./jarvis-mark";
import { ChatMarkdown } from "./markdown";

const ICON = { "aria-hidden": true, size: 13, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;
// Actions under a message stay quiet until the message is hovered or focused; touch shows them always.
const HOVER_ACTIONS =
  "opacity-0 transition-opacity duration-200 ease-ios group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100";

function utcTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hour12: false,
  }).format(timestamp);
}

interface PendingReply {
  readonly content: string;
  readonly status: string;
  readonly checking: boolean;
  readonly onCheck: (() => void) | null;
}

interface ChatMessageProps {
  readonly turn: ChatTurn;
  readonly last: boolean;
  readonly busy: boolean;
  readonly onRetry: (turn: ChatTurn) => void;
  readonly pendingReply: PendingReply | null;
}

function UserMessage({ text }: { readonly text: string }): ReactElement {
  return (
    <div className="group ml-auto flex max-w-reading flex-col items-end gap-1 pl-10 sm:pl-16">
      <div className="w-fit max-w-full whitespace-pre-wrap break-words rounded-lg bg-surface-2 px-4 py-2.5 text-body text-fg-strong ring-1 ring-line-card ring-inset">
        {text}
      </div>
      <div className={HOVER_ACTIONS}>
        <CopyButton text={text} />
      </div>
    </div>
  );
}

/**
 * Jarvis's side of a turn: the mark beside its first line, the content, then a quiet row below. The markup is the
 * same while streaming and once complete, so nothing jumps when the reply finishes; the status line shows work.
 */
function JarvisRow({ children }: { readonly children: ReactNode }) {
  return (
    <div className="jarvis-row group flex min-w-0 gap-3">
      <JarvisMark size={22} layered className="mt-px self-start" />
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">{children}</div>
    </div>
  );
}

function Receipt({ reply }: { readonly reply: ChatReply }): ReactElement {
  return (
    <details className="group/receipt min-w-0 text-caption">
      <summary className="inline-flex h-7 cursor-pointer list-none items-center gap-1.5 rounded-xs px-2 text-fg-subtle transition-colors duration-200 ease-ios hover:bg-surface-2 hover:text-fg-strong pointer-coarse:h-11 [&::-webkit-details-marker]:hidden">
        <ShieldCheck {...ICON} className="text-accent-text" />
        Model response verified
      </summary>
      <div className="mt-2 flex flex-col gap-3 card-shine rounded-md p-3 text-fg-subtle">
        {reply.context ? <p>Wallet and agent status · {utcTime(reply.context.readAt)} UTC.</p> : null}
        <dl className="grid gap-2 break-words">
          {[
            { term: "Model", value: reply.receipt.model, mono: false },
            { term: "Verified at", value: new Date(reply.receipt.verifiedAt).toISOString(), mono: true },
            { term: "Response ID", value: reply.receipt.completionId, mono: true },
            { term: "Evidence hash", value: reply.receipt.evidenceHash, mono: true },
          ].map(({ term, value, mono }) => (
            <div key={term} className="grid gap-0.5">
              <dt className="font-mono text-eyebrow uppercase text-fg-muted">{term}</dt>
              <dd className={mono ? "break-all font-mono text-fg" : "text-fg"}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}

function PendingStatus({ pending }: { readonly pending: PendingReply }): ReactElement {
  return (
    // data-jarvis-working turns the mark's ring in this row (globals.css → Jarvis mark).
    <div
      role="status"
      data-jarvis-working
      className="flex min-h-6 flex-wrap items-center gap-2 text-small text-fg-muted"
    >
      {pending.status ? <span>{pending.status}</span> : null}
      {pending.onCheck ? (
        <button
          type="button"
          disabled={pending.checking}
          onClick={pending.onCheck}
          className="inline-flex h-7 cursor-pointer items-center rounded-xs px-2 text-caption text-accent-text transition-colors duration-200 ease-ios hover:bg-surface-2 disabled:cursor-progress pointer-coarse:h-11"
        >
          {pending.checking ? "Checking…" : "Check response"}
        </button>
      ) : null}
    </div>
  );
}

function ReplyBody({ reply }: { readonly reply: ChatReply }) {
  return (
    <>
      <ChatMarkdown content={reply.content} />
      {reply.historyTrimmed ? (
        <p className="text-caption text-fg-subtle">
          This reply used the most recent messages that fit the context limit.
        </p>
      ) : null}
      <div className={`-ml-2 flex items-start gap-0.5 ${HOVER_ACTIONS}`}>
        <CopyButton text={reply.content} label="Copy reply" />
        <Receipt reply={reply} />
      </div>
    </>
  );
}

export const ChatMessage = memo(function ChatMessage({
  turn,
  last,
  busy,
  onRetry,
  pendingReply,
}: ChatMessageProps): ReactElement {
  const reply = turn.reply;
  const pending = turn.state === "pending" ? pendingReply : null;
  return (
    <article className="flex flex-col gap-5" aria-label={`Message ${turn.sequence}`}>
      <UserMessage text={turn.message} />
      {reply ? (
        <JarvisRow>
          <ReplyBody reply={reply} />
        </JarvisRow>
      ) : pending ? (
        <JarvisRow>
          {pending.content ? <ChatMarkdown content={pending.content} /> : null}
          <PendingStatus pending={pending} />
        </JarvisRow>
      ) : turn.state === "failed" || turn.state === "cancelled" ? (
        <JarvisRow>
          <div className="flex min-h-6 flex-wrap items-center gap-2 text-small text-fg-muted">
            <span>{turn.state === "cancelled" ? "Reply stopped." : "A reply wasn’t completed."}</span>
            {last ? (
              <button
                type="button"
                onClick={() => onRetry(turn)}
                disabled={busy}
                className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-xs px-2 text-caption text-fg-strong transition-colors duration-200 ease-ios hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-fg-disabled pointer-coarse:h-11"
              >
                <RotateCcw {...ICON} />
                Try again
              </button>
            ) : null}
          </div>
        </JarvisRow>
      ) : null}
    </article>
  );
});
