"use client";

import { MessageSquare } from "lucide-react";
import { AlertDialog } from "radix-ui";
import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import type { ConversationSummary } from "@/shared/chat";

interface DeleteChatDialogProps {
  readonly chat: ConversationSummary | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

/**
 * The confirm dialog layout (Docs/DESIGN.md → Typography → Layouts): rounded title, one line on the consequence, the
 * chat named in its own well, then the actions on one row.
 */
export function DeleteChatDialog({ chat, onCancel, onConfirm }: DeleteChatDialogProps): ReactElement {
  return (
    <AlertDialog.Root
      open={chat !== null}
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-bg/80" />
        <AlertDialog.Content className="card-shine fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-sm -translate-1/2 flex-col rounded-xl p-5 shadow-float">
          <AlertDialog.Title className="font-rounded text-h2 font-bold">Delete this chat?</AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-small text-fg-muted">
            Its messages are deleted for good.
          </AlertDialog.Description>
          <p className="mt-4 flex min-w-0 items-center gap-2 rounded-lg-inset bg-sunken px-3 py-2.5 text-small text-fg ring-1 ring-line-card ring-inset">
            <MessageSquare
              size={14}
              strokeWidth={1.75}
              absoluteStrokeWidth
              aria-hidden="true"
              className="shrink-0 text-fg-subtle"
            />
            <span className="truncate" title={chat?.title}>
              {chat?.title}
            </span>
          </p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <AlertDialog.Cancel asChild>
              <Button>Keep chat</Button>
            </AlertDialog.Cancel>
            <Button variant="destructive" onClick={onConfirm}>
              Delete
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
