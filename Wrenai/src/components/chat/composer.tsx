"use client";

import { ArrowUp, Square } from "lucide-react";
import type { KeyboardEvent, ReactElement, ReactNode, Ref } from "react";
import { MAX_CHAT_MESSAGE } from "@/shared/chat";
import type { ResearchTool } from "@/shared/research";
import { ChatToolPicker } from "./tool-picker";

interface ComposerProps {
  readonly value: string;
  readonly busy: boolean;
  readonly stopping: boolean;
  readonly disabled: boolean;
  readonly inputRef: Ref<HTMLTextAreaElement>;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly tool: ResearchTool | null;
  readonly onToolChange: (tool: ResearchTool | null) => void;
  readonly agentOffer: ReactNode;
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
  tool,
  onToolChange,
  agentOffer,
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
    <div className="relative mx-auto w-full max-w-reading shrink-0 pt-3">
      {agentOffer}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
        className="flex flex-col gap-1 card-shine rounded-lg p-2 transition-shadow duration-200 ease-ios focus-within:ring-1 focus-within:ring-line-strong/40 [&_button]:rounded-lg-inset"
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
          // Typing stays open while a reply streams, so the next message can be drafted; only sending waits.
          disabled={disabled}
          placeholder="Ask Jarvis anything…"
          aria-describedby="chat-composer-help"
          className="block max-h-[6lh] min-h-10 w-full min-w-0 resize-none overflow-y-auto bg-transparent py-2 px-2.5 text-body text-fg-strong outline-none placeholder:text-fg-subtle focus-visible:outline-none disabled:cursor-not-allowed"
          data-lenis-prevent
          style={{ fieldSizing: "content" }}
        />
        <div className="flex items-center justify-between gap-2">
          <ChatToolPicker value={tool} disabled={disabled || busy} onChange={onToolChange} />
          {busy ? (
            <button
              type="button"
              aria-label={stopping ? "Stopping reply" : "Stop reply"}
              disabled={stopping}
              onClick={onStop}
              className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-sm bg-surface-3 text-fg-strong transition-[background-color,scale] duration-200 ease-ios hover:bg-surface-4 active:scale-92 disabled:cursor-default motion-reduce:active:scale-100 pointer-coarse:size-11"
            >
              <Square size={14} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send message"
              disabled={disabled || !value.trim()}
              className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-sm bg-accent text-accent-fg transition-[background-color,scale] duration-200 ease-ios hover:bg-accent-text active:scale-92 disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-fg-disabled motion-reduce:active:scale-100 pointer-coarse:size-11"
            >
              <ArrowUp size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>
      </form>
      <p id="chat-composer-help" className="sr-only">
        Enter to send. Shift + Enter for a new line.
      </p>
    </div>
  );
}
