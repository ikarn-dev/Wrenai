"use client";
import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import { TokenIcon } from "./token-icon";

/** The popup every market page trades in: one floating surface with a close button (Radix Dialog). */
export function TradeDialog({
  open,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-bg/80" />
        <Dialog.Content className="fixed inset-x-gutter top-1/2 z-50 mx-auto max-h-[calc(100dvh-2rem)] max-w-sm -translate-y-1/2 overflow-y-auto rounded-xl bg-surface-2 p-card shadow-float">
          {children}
          <Dialog.Close
            aria-label="Close"
            className="absolute top-4 right-4 inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-fg-subtle transition-colors duration-200 ease-ios hover:bg-surface-3 hover:text-fg-strong pointer-coarse:size-11"
          >
            <X aria-hidden="true" size={16} strokeWidth={1.75} absoluteStrokeWidth />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The dialog's header: the asset's icon, "Trade X" or "Buy X", and one line of market figures. */
export function TradeDialogHeader({
  symbol,
  icon,
  title,
  detail,
}: {
  readonly symbol: string;
  readonly icon: string | null;
  readonly title: string;
  readonly detail: ReactNode;
}): ReactElement {
  return (
    <header className="flex items-center gap-2.5 pr-8">
      <TokenIcon symbol={symbol} icon={icon} size={28} />
      <div className="flex min-w-0 flex-col">
        <Dialog.Title className="truncate font-rounded text-h2 font-bold text-fg-strong">
          {title}
        </Dialog.Title>
        <Dialog.Description asChild>
          <div className="flex items-center gap-1.5 text-caption text-fg-subtle">{detail}</div>
        </Dialog.Description>
      </div>
    </header>
  );
}
