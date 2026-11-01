"use client";

import { ArrowUp, Square } from "lucide-react";
import type { KeyboardEvent, ReactElement, Ref } from "react";
import { MAX_CHAT_MESSAGE } from "@/shared/chat";

interface ComposerProps {
  readonly value: string;
  readonly busy: boolean;
  readonly stopping: boolean;
  readonly disabled: boolean;
  readonly inputRef: Ref<HTMLTextAreaElement>;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onStop: () => void;
}

export function ChatComposer({
  value,
  busy,
  stopping,
  disabled,
  inputRef,
  onChange,
  onSend,
  onStop,
}: ComposerProps): ReactElement {
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!busy && !disabled && value.trim()) {
        onSend();
      }
    }
  }

  return (
    <div className="mx-auto w-full max-w-reading shrink-0 pt-3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
        className="flex items-end gap-3 rounded-lg border border-line bg-surface-2 p-2.5 focus-within:border-line-strong sm:p-3"
      >
        <label htmlFor="chat-message" className="sr-only">
          Message Jarvis
        </label>
        <textarea
          id="chat-message"
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={keyDown}
          rows={1}
          maxLength={MAX_CHAT_MESSAGE}
          disabled={disabled || busy}
          placeholder="Ask Jarvis anything…"
          aria-describedby="chat-composer-help"
          className="block max-h-[6lh] min-h-11 min-w-0 flex-1 resize-none overflow-y-auto bg-surface-2 py-2.5 pl-2 text-body leading-relaxed text-fg-strong outline-none placeholder:text-fg-subtle focus-visible:outline-none disabled:cursor-not-allowed"
          data-lenis-prevent
          style={{ fieldSizing: "content" }}
        />
        {busy ? (
          <button
            type="button"
            aria-label={stopping ? "Stopping reply" : "Stop reply"}
            disabled={stopping}
            onClick={onStop}
            className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-line-strong text-fg-strong transition-colors hover:bg-surface-3 disabled:cursor-progress"
          >
            <Square size={16} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send message"
            disabled={disabled || !value.trim()}
            className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent text-accent-fg transition-colors hover:bg-accent-text disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-fg-disabled"
          >
            <ArrowUp size={20} aria-hidden="true" />
          </button>
        )}
      </form>
      <p id="chat-composer-help" className="sr-only">
        Enter to send. Shift + Enter for a new line.
      </p>
    </div>
  );
}
