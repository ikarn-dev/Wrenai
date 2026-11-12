"use client";
import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import { AgentAvatar } from "./avatar";

/** Shared by network adapters; only the setup data and allowed actions differ. */
export function AgentSetupDialogFrame({
  title,
  description,
  busy,
  modal = true,
  children,
  footer,
}: {
  readonly title: string;
  readonly description: string;
  readonly busy: boolean;
  readonly modal?: boolean;
  readonly children: ReactNode;
  readonly footer: ReactNode;
}): ReactElement | null {
  return (
    <Dialog.Portal>
      {modal ? (
        <Dialog.Overlay className="dialog-scrim fixed inset-0 z-40 bg-bg/80" />
      ) : (
        <div aria-hidden="true" className="fixed inset-0 z-40 bg-bg/80" />
      )}
      <Dialog.Content
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (busy) {
            event.preventDefault();
          }
        }}
        className="dialog-panel fixed inset-x-gutter top-1/2 z-50 mx-auto flex max-h-[calc(100dvh-2rem)] max-w-xl -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-surface-2 shadow-float"
      >
        <header className="flex items-center gap-3 px-card pt-card pr-16">
          <AgentAvatar size={28} running={busy} />
          <div className="flex min-w-0 flex-col gap-1">
            <Dialog.Title className="truncate font-rounded text-h2 font-bold text-fg-strong">
              {title}
            </Dialog.Title>
            <Dialog.Description className="text-caption text-fg-muted">{description}</Dialog.Description>
          </div>
        </header>
        <div data-lenis-prevent className="min-h-0 flex-1 overflow-y-auto px-card pt-5 pb-card">
          {children}
        </div>
        {footer}
        {busy ? null : (
          <Dialog.Close
            aria-label="Close"
            className="absolute top-4 right-4 inline-flex size-9 cursor-pointer items-center justify-center rounded-full text-fg-subtle transition-colors duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong pointer-coarse:size-11"
          >
            <X aria-hidden="true" size={16} strokeWidth={1.75} absoluteStrokeWidth />
          </Dialog.Close>
        )}
      </Dialog.Content>
    </Dialog.Portal>
  );
}
